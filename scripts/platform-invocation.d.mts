export interface PlatformInvocationOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
}

export interface PlatformInvocation {
  command: string;
  args: string[];
}

export function platformInvocation(
  command: string,
  args: string[],
  options?: PlatformInvocationOptions,
): PlatformInvocation;

export interface StoppableChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export function stopInvocation(
  child: StoppableChild,
  options?: { platform?: NodeJS.Platform; spawn?: (command: string, args: string[], options: object) => { once(event: "error", listener: () => void): unknown } },
): void;
