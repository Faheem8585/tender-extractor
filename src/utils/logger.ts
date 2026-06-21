function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export const log   = (msg: string): void => console.log(`[${ts()}] ${msg}`);
export const warn  = (msg: string): void => console.warn(`[${ts()}] WARN  ${msg}`);
export const error = (msg: string): void => console.error(`[${ts()}] ERROR ${msg}`);
