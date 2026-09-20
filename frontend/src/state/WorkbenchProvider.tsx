import { useEffect, type ReactNode } from "react";
import { useImportGestures } from "./gestures";
import { useJobStream } from "./jobs";
import { useLotterySync } from "./lottery";
import { useSession } from "./session";
import { useStudioSync } from "./studio";

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  useImportGestures();
  useJobStream();
  useLotterySync();
  useStudioSync();
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
