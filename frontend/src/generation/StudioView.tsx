import { MetaImportDialog } from "./components/MetaImportDialog";
import { ParamSetDialog } from "./components/ParamSetDialog";
import { StudioSkeleton } from "./skeleton/StudioSkeleton";

export function StudioView() {
  return (
    <>
      <StudioSkeleton />
      <ParamSetDialog />
      <MetaImportDialog />
    </>
  );
}

export { StudioView as default };
