import * as fs from "fs";

let _stream: fs.WriteStream | null = null;

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function write(line: string): void {
  if (_stream) _stream.write(line + "\n");
}

export function initLogger(logPath: string): void {
  _stream = fs.createWriteStream(logPath, { flags: "w" });
}

export const log = (msg: string): void => {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  write(line);
};

export const warn = (msg: string): void => {
  const line = `[${ts()}] WARN  ${msg}`;
  console.warn(line);
  write(line);
};

export const error = (msg: string): void => {
  const line = `[${ts()}] ERROR ${msg}`;
  console.error(line);
  write(line);
};
