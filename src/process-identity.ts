import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  executable: string;
  commandLine?: string;
}

export async function processExists(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function captureProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | null> {
  if (!(await processExists(pid))) return null;

  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTime = fields[19];
      const executable = await readlink(`/proc/${pid}/exe`);
      const commandLine = (await readFile(`/proc/${pid}/cmdline`))
        .toString("utf8")
        .replace(/\0+/g, " ")
        .trim();
      if (!startTime || !executable || !commandLine) return null;
      return { pid, startTime, executable, commandLine };
    } catch {
      return null;
    }
  }

  if (process.platform !== "darwin") return null;

  const [startTime, executable, commandLine] = await Promise.all([
    runPsField(pid, "lstart"),
    runPsField(pid, "comm"),
    runPsField(pid, "command"),
  ]);
  if (!startTime || !executable || !commandLine) return null;
  return { pid, startTime, executable, commandLine };
}

export function sameProcessIdentity(
  expected: ProcessIdentity,
  actual: ProcessIdentity,
): boolean {
  const expectedStart = normalizeStartTime(expected.startTime);
  const actualStart = normalizeStartTime(actual.startTime);
  return (
    expected.pid === actual.pid &&
    (expectedStart !== null || actualStart !== null
      ? expectedStart !== null && expectedStart === actualStart
      : expected.startTime === actual.startTime) &&
    expected.executable === actual.executable &&
    expected.commandLine === actual.commandLine
  );
}

function normalizeStartTime(value: string): string | null {
  const months: Record<string, number> = {
    jan: 1, january: 1, "января": 1,
    feb: 2, february: 2, "февраля": 2,
    mar: 3, march: 3, "марта": 3,
    apr: 4, april: 4, "апреля": 4,
    may: 5, "мая": 5,
    jun: 6, june: 6, "июня": 6,
    jul: 7, july: 7, "июля": 7,
    aug: 8, august: 8, "августа": 8,
    sep: 9, september: 9, "сентября": 9,
    oct: 10, october: 10, "октября": 10,
    nov: 11, november: 11, "ноября": 11,
    dec: 12, december: 12, "декабря": 12,
  };
  const english = value.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  const localized = value.match(/^(?:[^,]+,\s*)?(\d{1,2})\s+([\p{L}]+)\s+(\d{4})\s+г\.\s+(\d{1,2}):(\d{2}):(\d{2})$/u);
  const monthName = english?.[1]?.toLowerCase() ?? localized?.[2]?.toLowerCase();
  const month = monthName ? months[monthName] : undefined;
  if (!month) return null;
  const [year, day, hour, minute, second] = english
    ? [Number(english[6]), Number(english[2]), Number(english[3]), Number(english[4]), Number(english[5])]
    : [Number(localized![3]), Number(localized![1]), Number(localized![4]), Number(localized![5]), Number(localized![6])];
  if (
    !Number.isInteger(year) || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

async function runPsField(
  pid: number,
  field: "lstart" | "comm" | "command",
): Promise<string | null> {
  return await new Promise(resolve => {
    const child = spawn("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      `${field}=`,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => finish(null));
    child.once("close", code => {
      finish(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
  });
}
