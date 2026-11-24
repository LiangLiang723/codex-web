import { spawn } from "node:child_process";
import source from "./turn-file-rewind.py";

export const turnFileRewind = {
  run(request: unknown) {
    // 独立 helper 持有目录 FD 和事务。SSH 结束时留下可对账的日志，下次运行先恢复。
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn("python3", ["-I", "-c", source], { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (data: Buffer) => chunks.push(data));
      child.stdin.on("error", () => {});
      child.once("error", () => reject(Error("SSH 主机需要 Python 3 才能安全撤销文件")));
      child.once("close", (code) => {
        if (code !== 0) {
          reject(Error("SSH 文件撤销中断，重试可核对事务结果"));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof result?.error === "string") throw Error(result.error);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  },
};
