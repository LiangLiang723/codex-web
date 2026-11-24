import { z } from "zod";

const pngPrefix = "data:image/png;base64,";
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const workspaceAvatarSchema = z.union([
  z.enum(["server", "terminal", "cloud", "code", "cpu", "laptop"]),
  z
    .string()
    .max(100000)
    .refine((value) => {
      if (!value.startsWith(pngPrefix)) return false;
      const payload = value.slice(pngPrefix.length);
      if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
      const data = Buffer.from(payload, "base64");
      return (
        data.length >= 45 &&
        data.subarray(0, 8).equals(pngHeader) &&
        data.readUInt32BE(8) === 13 &&
        data.toString("ascii", 12, 16) === "IHDR" &&
        data.readUInt32BE(16) === 128 &&
        data.readUInt32BE(20) === 128 &&
        data.toString("ascii", data.length - 8, data.length - 4) === "IEND"
      );
    }, "Invalid workspace avatar"),
]);
