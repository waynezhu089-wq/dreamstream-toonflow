# Capability Library V0.3

The existing project, storyboard, model preset and composite tables remain unchanged.
Four additive tables hold families, immutable versions, endpoints and execution
provenance. Family has no lifecycle status. Only Version has DRAFT, VERIFIED and
DISABLED. Production calls `executeCapability(capabilityId, inputs)` with an exact
version ID; it never selects latest or substitutes another provider.

The Z-Image API workflow previously embedded in `compositeBackground.ts` is in
[`examples/z-image-turbo-v1.api.json`](../examples/z-image-turbo-v1.api.json).
It is an importable Comfy API Format example, not an automatically installed or
automatically verified Capability. The real local Comfy installation must have
the model files required by that workflow. Keep a successfully tested V1 frozen;
create V2 for a workflow, port or mapping change.

## Human setup and acceptance

1. Open **Settings → Capability Library → Setup · Comfy Endpoint**. Add `Local
   Comfy`, base URL `http://127.0.0.1:8188`, enabled.
2. **New Capability**: Name `Comfy｜Z-Image-Turbo 文生图 V1`, Family Key
   `comfy.z-image-turbo.txt2img`, category `image`. Save and configure V1.
3. Upload an actual Comfy **API Format** JSON exported from a workflow already
   run successfully on this machine. The bundled example above is the graph
   used by the earlier single-shot prototype and may be used when it matches
   the installed models. Normal users need not edit the graph.
4. Define input ports: `prompt` text, `width` number, `height` number,
   `seed` number, all required. Define output port `image` image.
5. In **Advanced / Setup**, map the four inputs to the corresponding workflow
   node inputs and `image` to its SaveImage `images` output. For the bundled
   workflow, the input mappings are `prompt→57:27.text`,
   `width→57:13.width`, `height→57:13.height`, `seed→57:3.seed`; output is
   `image→9.images`. These IDs exist only inside this Version's setup.
6. Save Draft, enter a harmless test prompt and width/height/seed, then
   **Test Run**. Confirm the displayed real image and Execution record. Click
   **Verify**. Run the same exact capability ID once more.

The earlier Composite screen keeps its blank-screen safety clause and calls
this VERIFIED capability through `executeCapability`. It does not send the real
product/UI asset to Comfy. Until V1 is verified, a new background attempt fails
explicitly; the previously completed shot and output remain preserved.

## API contract

All paths are authenticated POST endpoints under `/api/capabilities`:

- `/list`, `/family/create`, `/family/update`
- `/endpoint/list`, `/endpoint/save`
- `/version/get`, `/version/create`, `/version/update`, `/version/test`,
  `/version/verify`, `/version/disable`
- `/execute`, `/execution/list`, `/execution/read`

Version definition fields: `endpointId`, `workflowJson`, `inputPorts`,
`outputPorts`, `inputMappings`, `outputMappings`, `runtimeConfig`.

Input mapping is `{portName,nodeId,inputKey}` and assigns one logical value to
one existing `workflow[nodeId].inputs[inputKey]`. Output mapping is
`{portName,nodeId,field}` and reads `history.outputs[nodeId][field]`. There is
no expression engine or automatic Workflow analysis. The initial generic
executor accepts text, number, boolean and select inputs, and persists image or
image[] outputs; other declared schema types receive explicit unsupported input
or output errors until a future capability-specific implementation is approved.

Normalized execution result contains `executionId`, `capabilityId`, `status`,
`outputs`, `promptId`, `startedAt`, `completedAt`, `error`. An image output is a
Dream Stream OSS reference `{filePath,url,mimeType}`. The database stores that
reference, never raw bytes. Each execution records the exact version, endpoint,
inputs, prompt ID, output refs, status, timestamps, error and a definition hash.

The library supports one bound endpoint per Version. Endpoint auth, failover,
automatic Port discovery, Comfy node editing, cancellation, batch execution,
Skill compilation and other V0.3 platform modules are deferred.
