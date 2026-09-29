import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workbench } from "./app/Workbench";
import { WorkbenchProvider } from "@/state";
import { ArtistHoverProvider } from "./ui/ArtistHover";
import "./styles/app.css";
import "./styles/studio.css";
import "./styles/extra.css";

const client = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={client}>
      <WorkbenchProvider>
        <ArtistHoverProvider>
          <Workbench />
        </ArtistHoverProvider>
      </WorkbenchProvider>
    </QueryClientProvider>
  );
}
