import * as fs from 'node:fs';
import { parseModelSpec } from './provider-select.js';
import { t } from './i18n/index.js';

/**
 * syao doctor (FR-173): runs with NO provider keys. Checks Node version,
 * workspace writability, config presence and provider env references —
 * printing only whether keys are *set*, never their values (BR-023).
 */

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function runDoctor(cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= 22
      ? { name: 'node', status: 'ok', detail: t('doctor.nodeOk', { version: process.versions.node }) }
      : { name: 'node', status: 'fail', detail: t('doctor.nodeFail', { version: process.versions.node }) },
  );

  checks.push({ name: 'platform', status: 'ok', detail: `${process.platform} ${process.arch}` });
  checks.push({ name: 'workspace', status: 'ok', detail: cwd });

  try {
    const probe = `${cwd}/.syaocode-doctor-probe`;
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    checks.push({ name: 'workspace-writable', status: 'ok', detail: t('doctor.writableOk') });
  } catch (e) {
    checks.push({
      name: 'workspace-writable',
      status: 'fail',
      detail: t('doctor.writableFail', { error: e instanceof Error ? e.message : String(e) }),
    });
  }

  const userConfig = `${process.env.HOME ?? ''}/.syaocode/config.json`;
  const projectConfig = `${cwd}/.syaocode/config.json`;
  const userConfigExists = fs.existsSync(userConfig);
  const projectConfigExists = fs.existsSync(projectConfig);
  checks.push({
    name: 'config-user',
    status: userConfigExists ? 'ok' : 'warn',
    detail: userConfigExists ? t('doctor.configPresent', { path: userConfig }) : t('doctor.configAbsent', { path: userConfig }),
  });
  checks.push({
    name: 'config-project',
    status: projectConfigExists ? 'warn' : 'ok',
    detail: projectConfigExists
      ? t('doctor.projectPresent', { path: projectConfig })
      : t('doctor.projectAbsent', { path: projectConfig }),
  });

  const providers: [string, string][] = [
    ['OPENAI_API_KEY', 'openai-compatible'],
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
  ];
  for (const [envName, label] of providers) {
    const set = process.env[envName] !== undefined && process.env[envName] !== '';
    checks.push({
      name: `provider-${label}`,
      status: set ? 'ok' : 'warn',
      detail: set ? t('doctor.keySet', { env: envName }) : t('doctor.keyUnset', { env: envName }),
    });
  }

  try {
    const spec = parseModelSpec(undefined);
    checks.push({ name: 'default-model', status: 'ok', detail: `${spec.provider}:${spec.model}` });
  } catch (e) {
    checks.push({
      name: 'default-model',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: '✔', warn: '!', fail: '✘' } as const;
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(20)} ${c.detail}`).join('\n');
}
