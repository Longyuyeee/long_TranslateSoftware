import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const assetsDirectory = resolve(process.cwd(), "dist/assets");
const maximumChunkBytes = 300 * 1024;

const chunks = readdirSync(assetsDirectory)
  .filter((file) => file.endsWith(".js"))
  .map((file) => ({
    file,
    bytes: statSync(resolve(assetsDirectory, file)).size,
  }))
  .sort((left, right) => right.bytes - left.bytes);

if (chunks.length === 0) {
  throw new Error("No production JavaScript chunks were found. Run the build first.");
}

const oversized = chunks.filter((chunk) => chunk.bytes > maximumChunkBytes);
const largest = chunks[0];

console.log(
  `Largest production chunk: ${largest.file} (${(largest.bytes / 1024).toFixed(2)} KiB)`,
);
console.log(`Chunk size limit: ${(maximumChunkBytes / 1024).toFixed(0)} KiB`);

if (oversized.length > 0) {
  const details = oversized
    .map((chunk) => `${chunk.file}: ${(chunk.bytes / 1024).toFixed(2)} KiB`)
    .join("\n");
  throw new Error(`Production chunks exceed the size limit:\n${details}`);
}
