import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workbench } from "./app/Workbench";
import { WorkbenchProvider } from "@/state";
import "./styles/app.css";
import "./styles/studio.css";
import "./styles/extra.css";

const client = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={client}>
      <WorkbenchProvider>
        <Workbench />
      </WorkbenchProvider>
    </QueryClientProvider>
  );
}
