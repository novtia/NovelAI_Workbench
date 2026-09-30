import { useEffect, type ReactNode } from "react";
import { useImportGestures } from "./gestures";
import { useJobStream } from "./jobs";
import { useJobsQuery } from "./queries";
import { jobIsActive } from "@/data";
import { useLotterySync } from "./lottery";
import { useSession } from "./session";
import { useStudioSync } from "./studio";

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  useImportGestures();
  useJobStream();
  useLotterySync();
  useStudioSync();
  const jobs = useJobsQuery().data;
  const keep = Boolean(jobs?.some((job) => jobIsActive(job)));
  useEffect(() => {
    if (!keep || !navigator.locks) return;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void navigator.locks.request("workbench-keep", { mode: "shared" }, () => held);
    return () => release?.();
  }, [keep]);
  useEffect(() => {
    const onHash = () => {
      const raw = location.hash.replace("#", "");
      if (raw === "lottery" || raw === "studio" || raw === "gallery") {
        useSession.setState({ view: raw });
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return children;
}
