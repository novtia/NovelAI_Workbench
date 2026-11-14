import { afterEach, describe, expect, it } from "vitest";
import { _resetLoggerForTest, clearLogs, createLogger, exportLogsText, filterLogs, getLogs, setDebugEnabled } from "./logger";

describe("logger", () => {
  afterEach(() => {
    _resetLoggerForTest();
  });

  it("未启用调试时跳过 debug/info，仅记录 warn/error", () => {
    const log = createLogger("studio");
    log.debug("skip.debug", { a: 1 });
    log.info("skip.info", { b: 2 });
    expect(getLogs()).toHaveLength(0);

    log.warn("keep.warn", { code: 429 });
    expect(getLogs()).toHaveLength(1);
    expect(getLogs()[0].scope).toBe("studio");
    expect(getLogs()[0].level).toBe("warn");
  });

  it("启用调试后记录、过滤并导出日志", () => {
    setDebugEnabled(true);
    const studioLog = createLogger("studio");
    const apiLog = createLogger("api");
    studioLog.debug("generate.click", { tabId: "t1" });
    apiLog.info("submitJob.res", { id: "j1" });
    apiLog.error("submitJob.err", { status: 500 });

    const all = getLogs();
    expect(all).toHaveLength(3);
    expect(filterLogs(all, { query: "submitJob" })).toHaveLength(2);
    expect(filterLogs(all, { onlyWarn: true })).toHaveLength(1);

    const text = exportLogsText("generate.click");
    expect(text).toContain("[FE:studio]");
    expect(text).toContain("generate.click");

    clearLogs();
    expect(getLogs()).toHaveLength(0);
  });
});
