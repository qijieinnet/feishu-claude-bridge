import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { agentEnvironment } from "../src/agent-env.js";

test("agent and project descendants cannot inherit bridge configuration", () => {
  const parent = {
    ...process.env,
    FEISHU_APP_ID: "test-bridge-app",
    FEISHU_APP_SECRET: "test-bridge-secret",
    FEISHU_ALLOW_FROM: "test-user",
    LARK_APP_SECRET: "test-lark-secret",
    BRIDGE_HOME: "/test/bridge",
    BRIDGE_CODEX_HOME: "/test/bridge-codex-home",
    ANTHROPIC_API_KEY: "test-model-key",
    OPENAI_API_KEY: "test-openai-key",
    CODEX_HOME: "/test/codex-home",
    HTTPS_PROXY: "http://test-proxy:8080",
  };
  const original = { ...parent };
  const childScript = `
    const { execFileSync } = require('node:child_process');
    const grandchild = execFileSync(process.execPath, [
      '-e', 'console.log(JSON.stringify(process.env))'
    ], { encoding: 'utf8' });
    console.log(JSON.stringify({
      child: process.env,
      grandchild: JSON.parse(grandchild)
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["-e", childScript], {
    env: agentEnvironment(parent),
    encoding: "utf8",
  }));
  for (const env of [result.child, result.grandchild]) {
    assert.deepEqual(Object.keys(env).filter(k => /^(FEISHU_|LARK_|BRIDGE_)/i.test(k)), []);
    for (const key of ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "HTTPS_PROXY"]) {
      assert.equal(env[key], parent[key as keyof typeof parent]);
    }
  }
  assert.deepEqual(parent, original, "bridge configuration must remain intact");
});
