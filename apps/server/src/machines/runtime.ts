import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as MachineAssistantProject from "./assistant/MachineAssistantProject.ts";
import * as MachineConfigApply from "./assistant/MachineConfigApply.ts";
import * as MachinePlanApprover from "./assistant/MachinePlanApprover.ts";
import * as MachinePlanRunner from "./assistant/MachinePlanRunner.ts";
import * as MachinePlanStore from "./assistant/MachinePlanStore.ts";
import * as ConfigInventory from "./ConfigInventory.ts";
import * as MachineLocalImport from "./MachineLocalImport.ts";
import * as MachinePeerClient from "./MachinePeerClient.ts";
import * as MachineReceiver from "./MachineReceiver.ts";
import * as MachineSource from "./MachineSource.ts";
import * as MachineThreadMoves from "./MachineThreadMoves.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const layerEngine = Layer.mergeAll(
  MachineSource.layer,
  MachineReceiver.layer,
  MachineLocalImport.layer,
  ConfigInventory.layer,
  MachineThreadMoves.layer,
).pipe(Layer.provideMerge(Layer.merge(WorkingTreeSnapshot.layer, MachinePeerClient.layerHttp)));

/** Creates the Machines project once commands are accepted; a failure only logs. */
const layerAssistantProjectAtStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const assistant = yield* MachineAssistantProject.MachineAssistantProject;
    yield* startup.enqueueCommand(assistant.ensure).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("machines assistant project setup failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provideMerge(MachineAssistantProject.layer));

const layerAssistant = Layer.merge(MachinePlanRunner.layer, layerAssistantProjectAtStartup).pipe(
  Layer.provide(
    Layer.mergeAll(
      MachinePlanStore.layer,
      MachinePlanApprover.layerElicitation,
      MachineConfigApply.layer,
    ),
  ),
);

export const layer = layerAssistant.pipe(Layer.provideMerge(layerEngine));
