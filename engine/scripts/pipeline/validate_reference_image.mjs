import path from "node:path";
import { readValidatedReferenceImageInfo } from "../lib/pipeline_runtime.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  throw new Error("用法：node validate_reference_image.mjs <image-path>");
}

const imagePath = path.resolve(args[0]);
const info = await readValidatedReferenceImageInfo(imagePath);
if (!info) {
  throw new Error("参考图片结构、尺寸、大小或扩展名无效");
}
process.stdout.write(JSON.stringify(info));
