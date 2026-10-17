/**
 * Agents may launch projects that also read FEISHU_APP_ID/FEISHU_APP_SECRET.
 * Keep bridge configuration in the parent, never in the agent's environment.
 * Copy rather than mutate process.env: the bridge still needs its credentials.
 */
export function agentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !/^(FEISHU_|LARK_|BRIDGE_)/i.test(name),
    ),
  );
}
