import type { ReactNode } from "react";

export function PoolEmpty({ children }: { children: ReactNode }) {
  return <p className="pool-empty">{children}</p>;
}
