import { createFileRoute } from "@tanstack/react-router";

import { MachinesPage } from "../components/machines/MachinesPage";

export const Route = createFileRoute("/_chat/machines")({
  component: MachinesPage,
});
