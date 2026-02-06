import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileSizeLimitError,
  MediaTimeoutError,
  cleanupFileSafe,
  downloadToTempFile,
  finalizeInboundMediaFile,
  pruneInboundMediaDir,
} from "./media-io.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

describe("downloadToTempFile", () => {
  it("downloads HTTP response and stores a temp file", async () => {
    const dir = await createTempDir("shared-media-io-");
    const body = Buffer.from("hello-media", "utf8");
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(body.length),
        },
      });

    const result = await downloadToTempFile("https://example.com/a.png", {
      fetch: fetchFn,
      tempDir: dir,
      tempPrefix: "dingtalk-file",
    });

    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.fileName.endsWith(".png")).toBe(true);
    expect(result.size).toBe(body.length);
    expect(result.contentType).toBe("image/png");

    const saved = await fsPromises.readFile(result.path);
    expect(saved.equals(body)).toBe(true);
  });

  it("throws FileSizeLimitError when Content-Length exceeds maxSize", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("too-large", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "1024",
        },
      });

    await expect(
      downloadToTempFile("https://example.com/too-large.bin", {
        fetch: fetchFn,
        maxSize: 100,
      })
    ).rejects.toBeInstanceOf(FileSizeLimitError);
  });

  it("throws MediaTimeoutError on timeout", async () => {
    const fetchFn: typeof globalThis.fetch = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });

    await expect(
      downloadToTempFile("https://example.com/slow.bin", {
        fetch: fetchFn,
        timeout: 10,
      })
    ).rejects.toBeInstanceOf(MediaTimeoutError);
  });
});

describe("cleanupFileSafe", () => {
  it("removes file and ignores missing file", async () => {
    const dir = await createTempDir("shared-media-clean-");
    const filePath = path.join(dir, "a.txt");
    await fsPromises.writeFile(filePath, "x", "utf8");
    expect(fs.existsSync(filePath)).toBe(true);

    await cleanupFileSafe(filePath);
    expect(fs.existsSync(filePath)).toBe(false);

    await expect(cleanupFileSafe(filePath)).resolves.toBeUndefined();
    await expect(cleanupFileSafe(undefined)).resolves.toBeUndefined();
  });
});

describe("inbound media retention", () => {
  it("finalizes temp media into inbound/YYYY-MM-DD", async () => {
    const tempDir = await createTempDir("shared-media-temp-");
    const inboundDir = await createTempDir("shared-media-inbound-");
    const sourcePath = path.join(tempDir, "img-1.jpg");
    await fsPromises.writeFile(sourcePath, "abc", "utf8");

    const finalPath = await finalizeInboundMediaFile({
      filePath: sourcePath,
      tempDir,
      inboundDir,
    });

    expect(finalPath.startsWith(inboundDir)).toBe(true);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("does not move files outside tempDir", async () => {
    const tempDir = await createTempDir("shared-media-temp-");
    const inboundDir = await createTempDir("shared-media-inbound-");
    const outsideDir = await createTempDir("shared-media-outside-");
    const sourcePath = path.join(outsideDir, "a.txt");
    await fsPromises.writeFile(sourcePath, "x", "utf8");

    const finalPath = await finalizeInboundMediaFile({
      filePath: sourcePath,
      tempDir,
      inboundDir,
    });

    expect(finalPath).toBe(sourcePath);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("prunes only expired files in date dirs and keeps recent files", async () => {
    const inboundDir = await createTempDir("shared-media-prune-");
    const oldDir = path.join(inboundDir, "2024-01-01");
    const newDir = path.join(inboundDir, "2024-01-02");
    await fsPromises.mkdir(oldDir, { recursive: true });
    await fsPromises.mkdir(newDir, { recursive: true });

    const oldFile = path.join(oldDir, "old.jpg");
    const newFile = path.join(newDir, "new.jpg");
    const nestedDir = path.join(oldDir, "nested");
    const nestedFile = path.join(nestedDir, "nested.jpg");
    await fsPromises.writeFile(oldFile, "old", "utf8");
    await fsPromises.writeFile(newFile, "new", "utf8");
    await fsPromises.mkdir(nestedDir, { recursive: true });
    await fsPromises.writeFile(nestedFile, "nested", "utf8");

    const oldTs = new Date("2024-01-01T00:00:00.000Z");
    const newTs = new Date("2024-01-02T00:00:00.000Z");
    await fsPromises.utimes(oldDir, oldTs, oldTs);
    await fsPromises.utimes(oldFile, oldTs, oldTs);
    await fsPromises.utimes(newDir, newTs, newTs);
    await fsPromises.utimes(newFile, newTs, newTs);

    const nowMs = new Date("2024-01-03T00:00:00.000Z").getTime();
    await pruneInboundMediaDir({
      inboundDir,
      keepDays: 1,
      nowMs,
    });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(nestedFile)).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(true);
  });
});
