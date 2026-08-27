export class ComfyWorkflowSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyWorkflowSemanticError";
  }
}

type NodeId = number | string;

type ComfyInput = {
  name: string;
  link?: number | null;
  widget?: unknown;
};

type ComfyOutput = {
  name: string;
};

type ComfyNode = {
  id: NodeId;
  type: string;
  mode?: number;
  inputs: ComfyInput[];
  outputs: ComfyOutput[];
  widgetsValues: unknown[];
};

type ComfyLink = {
  id: number;
  originId: NodeId;
  originSlot: number;
  targetId: NodeId;
  targetSlot: number;
  type: string;
};

type ComfyBoundaryPort = {
  name: string;
};

type ComfyGraph = {
  name: string;
  nodes: ComfyNode[];
  links: ComfyLink[];
  inputs: ComfyBoundaryPort[];
  outputs: ComfyBoundaryPort[];
};

type ComfySubgraph = ComfyGraph & {
  id: string;
};

type ExpandedBinding =
  | { kind: "constant"; value: unknown; source: string }
  | { kind: "node"; nodeKey: string; outputSlot: number };

type ExpandedNode = {
  key: string;
  path: string;
  root: boolean;
  type: string;
  inputs: Map<string, ExpandedBinding>;
  widgetsValues: unknown[];
};

type ExpandedGraph = {
  nodes: Map<string, ExpandedNode>;
  rootNodeKeys: string[];
};

export type Ltx25SamplerStageSemantics = {
  path: string;
  sampler: string;
  cfg: number;
  seed: number;
  sigmaSource: string;
  sigmaTokens: string[];
  sigmaFloat32: number[];
  sigmaFloat32Bits: string[];
  spatialLatentUpscalerBefore: boolean;
};

export type Ltx25WorkflowSemantics = {
  stages: Ltx25SamplerStageSemantics[];
  primarySinkTypes: string[];
  videoDecodeCount: number;
  audioDecodeCount: number;
  createVideoCount: number;
  reachableNodeTypes: string[];
};

const MEDIA_SINK_TYPES = new Set(["PreviewAudio", "SaveAudio", "SaveAudioAdvanced", "SaveVideo"]);
const VIDEO_DECODE_TYPES = new Set(["VAEDecode", "VAEDecodeTiled"]);
const AUDIO_DECODE_TYPES = new Set(["LTXVAudioVAEDecode"]);

function fail(message: string): never {
  throw new ComfyWorkflowSemanticError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function anyString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) fail(`${label} must be an integer`);
  return value as number;
}

function nodeId(value: unknown, label: string): NodeId {
  if ((typeof value !== "number" || !Number.isInteger(value)) && typeof value !== "string") {
    fail(`${label} must be an integer or string`);
  }
  return value as NodeId;
}

function parseInput(value: unknown, label: string): ComfyInput {
  const raw = object(value, label);
  const link = raw.link;
  if (link !== undefined && link !== null && !Number.isInteger(link)) {
    fail(`${label}.link must be an integer or null`);
  }
  return {
    name: anyString(raw.name, `${label}.name`),
    ...(link === undefined ? {} : { link: link as number | null }),
    ...(raw.widget === undefined ? {} : { widget: raw.widget }),
  };
}

function parseOutput(value: unknown, label: string): ComfyOutput {
  const raw = object(value, label);
  return { name: anyString(raw.name, `${label}.name`) };
}

function parseNode(value: unknown, label: string): ComfyNode {
  const raw = object(value, label);
  const mode = raw.mode === undefined ? 0 : integer(raw.mode, `${label}.mode`);
  if (mode !== 0) fail(`${label} uses unsupported execution mode ${mode}`);
  const widgets = raw.widgets_values;
  if (widgets !== undefined && widgets !== null && !Array.isArray(widgets)) {
    fail(`${label}.widgets_values must be an array or null`);
  }
  const inputs = raw.inputs === undefined ? [] : array(raw.inputs, `${label}.inputs`)
    .map((input, index) => parseInput(input, `${label}.inputs[${index}]`));
  const inputNames = new Set<string>();
  for (const input of inputs) {
    if (inputNames.has(input.name)) fail(`${label} has duplicate input ${input.name}`);
    inputNames.add(input.name);
  }
  return {
    id: nodeId(raw.id, `${label}.id`),
    type: string(raw.type, `${label}.type`),
    mode,
    inputs,
    outputs: raw.outputs === undefined ? [] : array(raw.outputs, `${label}.outputs`)
      .map((output, index) => parseOutput(output, `${label}.outputs[${index}]`)),
    widgetsValues: widgets === undefined || widgets === null ? [] : [...widgets],
  };
}

function parseLink(value: unknown, label: string): ComfyLink {
  if (Array.isArray(value)) {
    if (value.length < 6) fail(`${label} tuple must contain six fields`);
    return {
      id: integer(value[0], `${label}[0]`),
      originId: nodeId(value[1], `${label}[1]`),
      originSlot: integer(value[2], `${label}[2]`),
      targetId: nodeId(value[3], `${label}[3]`),
      targetSlot: integer(value[4], `${label}[4]`),
      type: typeof value[5] === "string" ? value[5] : "",
    };
  }
  const raw = object(value, label);
  return {
    id: integer(raw.id, `${label}.id`),
    originId: nodeId(raw.origin_id, `${label}.origin_id`),
    originSlot: integer(raw.origin_slot, `${label}.origin_slot`),
    targetId: nodeId(raw.target_id, `${label}.target_id`),
    targetSlot: integer(raw.target_slot, `${label}.target_slot`),
    type: typeof raw.type === "string" ? raw.type : "",
  };
}

function parseBoundaryPorts(value: unknown, label: string): ComfyBoundaryPort[] {
  if (value === undefined) return [];
  const ports = array(value, label).map((port, index) => {
    const raw = object(port, `${label}[${index}]`);
    return { name: anyString(raw.name, `${label}[${index}].name`) };
  });
  const names = new Set<string>();
  for (const port of ports) {
    if (names.has(port.name)) fail(`${label} has duplicate port ${port.name}`);
    names.add(port.name);
  }
  return ports;
}

function parseGraph(value: unknown, label: string): ComfyGraph {
  const raw = object(value, label);
  const nodes = array(raw.nodes, `${label}.nodes`).map((node, index) => (
    parseNode(node, `${label}.nodes[${index}]`)
  ));
  const nodeIds = new Set<NodeId>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail(`${label} has duplicate node id ${String(node.id)}`);
    nodeIds.add(node.id);
  }
  const links = array(raw.links ?? [], `${label}.links`).map((link, index) => (
    parseLink(link, `${label}.links[${index}]`)
  ));
  const linkIds = new Set<number>();
  for (const link of links) {
    if (linkIds.has(link.id)) fail(`${label} has duplicate link id ${link.id}`);
    linkIds.add(link.id);
  }
  return {
    name: label,
    nodes,
    links,
    inputs: parseBoundaryPorts(raw.inputs, `${label}.inputs`),
    outputs: parseBoundaryPorts(raw.outputs, `${label}.outputs`),
  };
}

function parseWorkflow(value: unknown): { root: ComfyGraph; subgraphs: Map<string, ComfySubgraph> } {
  const raw = object(value, "workflow");
  const root = parseGraph(raw, "workflow");
  const definitions = object(raw.definitions, "workflow.definitions");
  const subgraphs = new Map<string, ComfySubgraph>();
  for (const [index, value] of array(definitions.subgraphs, "workflow.definitions.subgraphs").entries()) {
    const subgraphRaw = object(value, `workflow.definitions.subgraphs[${index}]`);
    const id = string(subgraphRaw.id, `workflow.definitions.subgraphs[${index}].id`);
    if (subgraphs.has(id)) fail(`workflow has duplicate subgraph id ${id}`);
    const graph = parseGraph(value, `workflow.definitions.subgraphs[${index}]`);
    subgraphs.set(id, { ...graph, id, name: typeof subgraphRaw.name === "string" ? subgraphRaw.name : id });
  }
  return { root, subgraphs };
}

function linkMap(graph: ComfyGraph): Map<number, ComfyLink> {
  return new Map(graph.links.map((link) => [link.id, link]));
}

function float32Bits(value: number): string {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0");
}

function expandWorkflow(root: ComfyGraph, subgraphs: Map<string, ComfySubgraph>): ExpandedGraph {
  const expandedNodes = new Map<string, ExpandedNode>();
  const rootNodeKeys: string[] = [];
  const activeSubgraphs: string[] = [];

  function expandScope(
    graph: ComfyGraph,
    scopePath: string,
    rootScope: boolean,
    boundaryInputs: Map<number, ExpandedBinding>,
  ): Map<number, ExpandedBinding> {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const linksById = linkMap(graph);
    const instanceOutputs = new Map<NodeId, Map<number, ExpandedBinding>>();
    const expandingInstances = new Set<NodeId>();

    for (const node of graph.nodes) {
      if (subgraphs.has(node.type)) continue;
      const key = `${scopePath}/${String(node.id)}`;
      if (expandedNodes.has(key)) fail(`expanded node key collision at ${key}`);
      expandedNodes.set(key, {
        key,
        path: key,
        root: rootScope,
        type: node.type,
        inputs: new Map(),
        widgetsValues: node.widgetsValues,
      });
      if (rootScope) rootNodeKeys.push(key);
    }

    function sourceForLink(linkId: number, context: string): ExpandedBinding {
      const link = linksById.get(linkId);
      if (!link) fail(`${context} references missing link ${linkId}`);
      if (link.originId === -10) {
        const binding = boundaryInputs.get(link.originSlot);
        if (!binding) fail(`${context} references unbound subgraph input ${link.originSlot}`);
        return binding;
      }
      if (link.originId === -20) fail(`${context} has invalid output-boundary origin`);
      return outputForNode(link.originId, link.originSlot, context);
    }

    function widgetInputSlots(definition: ComfySubgraph): number[] {
      const definitionNodes = new Map(definition.nodes.map((node) => [node.id, node]));
      return definition.inputs.flatMap((_input, inputSlot) => {
        const boundaryLinks = definition.links.filter((link) => (
          link.originId === -10 && link.originSlot === inputSlot
        ));
        const targetsWidget = boundaryLinks.some((link) => {
          const target = definitionNodes.get(link.targetId);
          const targetInput = target?.inputs.find((input) => input.link === link.id);
          return targetInput?.widget !== undefined;
        });
        return targetsWidget ? [inputSlot] : [];
      });
    }

    function expandInstance(instance: ComfyNode, context: string): Map<number, ExpandedBinding> {
      const cached = instanceOutputs.get(instance.id);
      if (cached) return cached;
      if (expandingInstances.has(instance.id)) fail(`${context} contains a recursive instance cycle`);
      const definition = subgraphs.get(instance.type);
      if (!definition) fail(`${context} references unknown subgraph ${instance.type}`);
      if (activeSubgraphs.includes(definition.id)) {
        fail(`${context} recursively expands subgraph ${definition.name}`);
      }
      expandingInstances.add(instance.id);
      activeSubgraphs.push(definition.id);
      try {
        const widgetSlots = widgetInputSlots(definition);
        if (widgetSlots.length !== instance.widgetsValues.length) {
          fail(
            `${context} exposes ${widgetSlots.length} widget inputs but stores `
            + `${instance.widgetsValues.length} widget values`,
          );
        }
        const widgetOrdinal = new Map(widgetSlots.map((slot, index) => [slot, index]));
        const instanceInputByName = new Map(instance.inputs.map((input) => [input.name, input]));
        for (const name of instanceInputByName.keys()) {
          if (!definition.inputs.some((input) => input.name === name)) {
            fail(`${context} exposes unknown subgraph input ${name}`);
          }
        }
        const childInputs = new Map<number, ExpandedBinding>();
        for (const [inputSlot, port] of definition.inputs.entries()) {
          const instanceInput = instanceInputByName.get(port.name);
          if (instanceInput?.link !== undefined && instanceInput.link !== null) {
            childInputs.set(inputSlot, sourceForLink(instanceInput.link, `${context}.${port.name}`));
            continue;
          }
          const ordinal = widgetOrdinal.get(inputSlot);
          if (ordinal !== undefined) {
            childInputs.set(inputSlot, {
              kind: "constant",
              value: instance.widgetsValues[ordinal],
              source: `${context}.widgets_values[${ordinal}]`,
            });
          }
        }
        const outputs = expandScope(
          definition,
          `${scopePath}/${String(instance.id)}:${definition.name}`,
          false,
          childInputs,
        );
        instanceOutputs.set(instance.id, outputs);
        return outputs;
      } finally {
        activeSubgraphs.pop();
        expandingInstances.delete(instance.id);
      }
    }

    function outputForNode(nodeId: NodeId, outputSlot: number, context: string): ExpandedBinding {
      const node = nodesById.get(nodeId);
      if (!node) fail(`${context} references missing origin node ${String(nodeId)}`);
      if (subgraphs.has(node.type)) {
        const binding = expandInstance(node, `${scopePath}/${String(node.id)}`)?.get(outputSlot);
        if (!binding) fail(`${context} references missing subgraph output ${outputSlot}`);
        return binding;
      }
      if (outputSlot < 0 || outputSlot >= node.outputs.length) {
        fail(`${context} references missing output ${outputSlot} on node ${String(node.id)}`);
      }
      return { kind: "node", nodeKey: `${scopePath}/${String(node.id)}`, outputSlot };
    }

    for (const node of graph.nodes) {
      if (subgraphs.has(node.type)) continue;
      const expanded = expandedNodes.get(`${scopePath}/${String(node.id)}`);
      if (!expanded) fail(`internal expansion error at ${scopePath}/${String(node.id)}`);
      for (const input of node.inputs) {
        if (input.link === undefined || input.link === null) continue;
        expanded.inputs.set(input.name, sourceForLink(input.link, `${expanded.path}.${input.name}`));
      }
    }

    for (const node of graph.nodes) {
      if (subgraphs.has(node.type)) expandInstance(node, `${scopePath}/${String(node.id)}`);
    }

    const outputs = new Map<number, ExpandedBinding>();
    for (const link of graph.links.filter((candidate) => candidate.targetId === -20)) {
      if (outputs.has(link.targetSlot)) fail(`${scopePath} has duplicate output binding ${link.targetSlot}`);
      if (link.originId === -10) {
        const binding = boundaryInputs.get(link.originSlot);
        if (!binding) fail(`${scopePath} output ${link.targetSlot} references an unbound input`);
        outputs.set(link.targetSlot, binding);
      } else {
        outputs.set(link.targetSlot, outputForNode(link.originId, link.originSlot, `${scopePath}.output`));
      }
    }
    for (let index = 0; index < graph.outputs.length; index += 1) {
      if (!outputs.has(index)) fail(`${scopePath} is missing subgraph output ${index}`);
    }
    return outputs;
  }

  expandScope(root, "root", true, new Map());
  return { nodes: expandedNodes, rootNodeKeys };
}

function ancestorsOfBinding(
  graph: ExpandedGraph,
  binding: ExpandedBinding,
  seen: Set<string> = new Set(),
  stack: Set<string> = new Set(),
): Set<string> {
  if (binding.kind === "constant") return seen;
  if (stack.has(binding.nodeKey)) fail(`expanded graph contains a cycle at ${binding.nodeKey}`);
  if (seen.has(binding.nodeKey)) return seen;
  const node = graph.nodes.get(binding.nodeKey);
  if (!node) fail(`expanded binding references missing node ${binding.nodeKey}`);
  seen.add(binding.nodeKey);
  stack.add(binding.nodeKey);
  for (const input of node.inputs.values()) ancestorsOfBinding(graph, input, seen, stack);
  stack.delete(binding.nodeKey);
  return seen;
}

function ancestorsOfNode(graph: ExpandedGraph, node: ExpandedNode): Set<string> {
  const seen = new Set<string>([node.key]);
  const stack = new Set<string>([node.key]);
  for (const input of node.inputs.values()) ancestorsOfBinding(graph, input, seen, stack);
  return seen;
}

function nodeTypes(graph: ExpandedGraph, keys: Iterable<string>): string[] {
  return [...keys].map((key) => graph.nodes.get(key)?.type ?? fail(`missing expanded node ${key}`));
}

function sourceNode(graph: ExpandedGraph, binding: ExpandedBinding, expectedType: string): ExpandedNode {
  if (binding.kind !== "node") fail(`expected ${expectedType}, received a constant from ${binding.source}`);
  const direct = graph.nodes.get(binding.nodeKey);
  if (!direct) fail(`missing expanded node ${binding.nodeKey}`);
  if (direct.type === expectedType) return direct;
  const matches = [...ancestorsOfBinding(graph, binding)]
    .map((key) => graph.nodes.get(key) ?? fail(`missing expanded node ${key}`))
    .filter((node) => node.type === expectedType);
  if (matches.length !== 1) {
    fail(`${direct.path} has ${matches.length} upstream ${expectedType} nodes; expected exactly one`);
  }
  return matches[0];
}

function resolveConstant(graph: ExpandedGraph, binding: ExpandedBinding, stack = new Set<string>()): unknown {
  if (binding.kind === "constant") return binding.value;
  if (stack.has(binding.nodeKey)) fail(`constant resolution cycle at ${binding.nodeKey}`);
  const node = graph.nodes.get(binding.nodeKey);
  if (!node) fail(`constant binding references missing node ${binding.nodeKey}`);
  stack.add(binding.nodeKey);
  try {
    if (node.type === "Reroute") {
      const input = node.inputs.values().next().value as ExpandedBinding | undefined;
      if (!input) fail(`${node.path} has no reroute input`);
      return resolveConstant(graph, input, stack);
    }
    if (/^Primitive(?:Boolean|Float|Int|String|StringMultiline)$/.test(node.type)) {
      const linked = node.inputs.get("value");
      if (linked) return resolveConstant(graph, linked, stack);
      if (node.widgetsValues.length === 0) fail(`${node.path} has no primitive value`);
      return node.widgetsValues[0];
    }
    fail(`${node.path} is not a statically supported constant source`);
  } finally {
    stack.delete(binding.nodeKey);
  }
}

function effectiveWidget(
  graph: ExpandedGraph,
  node: ExpandedNode,
  inputName: string,
  widgetIndex: number,
): unknown {
  const binding = node.inputs.get(inputName);
  if (binding) return resolveConstant(graph, binding);
  if (widgetIndex >= node.widgetsValues.length) fail(`${node.path} is missing widget ${widgetIndex}`);
  return node.widgetsValues[widgetIndex];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function finiteInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be a safe integer`);
  return parsed;
}

function samplerStage(graph: ExpandedGraph, sampler: ExpandedNode): Ltx25SamplerStageSemantics {
  const samplerBinding = sampler.inputs.get("sampler") ?? fail(`${sampler.path} has no sampler input`);
  const sigmaBinding = sampler.inputs.get("sigmas") ?? fail(`${sampler.path} has no sigmas input`);
  const guiderBinding = sampler.inputs.get("guider") ?? fail(`${sampler.path} has no guider input`);
  const noiseBinding = sampler.inputs.get("noise") ?? fail(`${sampler.path} has no noise input`);
  const latentBinding = sampler.inputs.get("latent_image") ?? fail(`${sampler.path} has no latent input`);
  const samplerSelect = sourceNode(graph, samplerBinding, "KSamplerSelect");
  const manualSigmas = sourceNode(graph, sigmaBinding, "ManualSigmas");
  const guider = sourceNode(graph, guiderBinding, "CFGGuider");
  const noise = sourceNode(graph, noiseBinding, "RandomNoise");
  const samplerName = effectiveWidget(graph, samplerSelect, "sampler_name", 0);
  if (typeof samplerName !== "string" || samplerName.length === 0) {
    fail(`${samplerSelect.path} has an invalid sampler name`);
  }
  const sigmaSource = effectiveWidget(graph, manualSigmas, "sigmas", 0);
  if (typeof sigmaSource !== "string") fail(`${manualSigmas.path} has a non-string sigma schedule`);
  const sigmaTokens = sigmaSource.match(/[-+]?(?:\d*\.*\d+)/g) ?? [];
  if (sigmaTokens.length < 2) fail(`${manualSigmas.path} has an invalid sigma schedule`);
  const sigmaFloat32 = sigmaTokens.map((token) => Math.fround(Number(token)));
  if (sigmaFloat32.some((value) => !Number.isFinite(value))) {
    fail(`${manualSigmas.path} has a non-finite sigma value`);
  }
  const latentAncestors = ancestorsOfBinding(graph, latentBinding);
  return {
    path: sampler.path,
    sampler: samplerName,
    cfg: finiteNumber(effectiveWidget(graph, guider, "cfg", 0), `${guider.path}.cfg`),
    seed: finiteInteger(effectiveWidget(graph, noise, "noise_seed", 0), `${noise.path}.noise_seed`),
    sigmaSource,
    sigmaTokens,
    sigmaFloat32,
    sigmaFloat32Bits: sigmaFloat32.map(float32Bits),
    spatialLatentUpscalerBefore: [...latentAncestors]
      .some((key) => graph.nodes.get(key)?.type === "LTXVLatentUpsampler"),
  };
}

function topologicalSamplerOrder(graph: ExpandedGraph, samplers: ExpandedNode[]): ExpandedNode[] {
  const samplerKeys = new Set(samplers.map((sampler) => sampler.key));
  const dependencies = new Map<string, Set<string>>();
  for (const sampler of samplers) {
    const latent = sampler.inputs.get("latent_image") ?? fail(`${sampler.path} has no latent input`);
    dependencies.set(
      sampler.key,
      new Set([...ancestorsOfBinding(graph, latent)].filter((key) => samplerKeys.has(key))),
    );
  }
  const ordered: ExpandedNode[] = [];
  const remaining = new Set(samplerKeys);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) => (
      [...(dependencies.get(key) ?? [])].every((dependency) => !remaining.has(dependency))
    ));
    if (ready.length === 0) fail("sampler stages contain a dependency cycle");
    ready.sort();
    for (const key of ready) {
      ordered.push(graph.nodes.get(key) ?? fail(`missing sampler ${key}`));
      remaining.delete(key);
    }
  }
  if (ordered.length > 1) {
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const currentDependencies = dependencies.get(ordered[index].key) ?? new Set();
      if (!currentDependencies.has(previous.key)) {
        fail(`sampler stages ${previous.path} and ${ordered[index].path} are not a single decode lineage`);
      }
    }
  }
  return ordered;
}

export function analyzeLtx25Workflow(value: unknown): Ltx25WorkflowSemantics {
  const parsed = parseWorkflow(value);
  const graph = expandWorkflow(parsed.root, parsed.subgraphs);
  const candidateSinks = graph.rootNodeKeys
    .map((key) => graph.nodes.get(key) ?? fail(`missing root node ${key}`))
    .filter((node) => MEDIA_SINK_TYPES.has(node.type));
  const primaryLineages = candidateSinks.map((sink) => ({ sink, ancestors: ancestorsOfNode(graph, sink) }))
    .filter(({ ancestors }) => {
      const types = new Set(nodeTypes(graph, ancestors));
      return types.has("SamplerCustomAdvanced")
        && ([...VIDEO_DECODE_TYPES].some((type) => types.has(type))
          || [...AUDIO_DECODE_TYPES].some((type) => types.has(type)));
    });
  if (primaryLineages.length === 0) fail("workflow has no sampler-to-decode media lineage");
  const reachable = new Set<string>();
  for (const lineage of primaryLineages) for (const key of lineage.ancestors) reachable.add(key);
  const reachableNodes = [...reachable].map((key) => graph.nodes.get(key) ?? fail(`missing node ${key}`));
  const orderedSamplers = topologicalSamplerOrder(
    graph,
    reachableNodes.filter((node) => node.type === "SamplerCustomAdvanced"),
  );
  if (orderedSamplers.length === 0) fail("workflow media lineage has no sampler stage");
  return {
    stages: orderedSamplers.map((sampler) => samplerStage(graph, sampler)),
    primarySinkTypes: [...new Set(primaryLineages.map(({ sink }) => sink.type))].sort(),
    videoDecodeCount: reachableNodes.filter((node) => VIDEO_DECODE_TYPES.has(node.type)).length,
    audioDecodeCount: reachableNodes.filter((node) => AUDIO_DECODE_TYPES.has(node.type)).length,
    createVideoCount: reachableNodes.filter((node) => node.type === "CreateVideo").length,
    reachableNodeTypes: [...new Set(reachableNodes.map((node) => node.type))].sort(),
  };
}
