import buildInfo from '../../build-info.js';
import packageInfo from '../../package-info.js';
import { type ConfigService } from '../config/config.service.js';

// `HTTP_USER_AGENT` unset -> `csm-prover-tool/1.2.3`, empty -> no header at all.
export function userAgentHeaders(config: ConfigService): Record<string, string> {
  const configured = config.get('HTTP_USER_AGENT');
  const ua = configured === undefined ? `${packageInfo.name}/${buildInfo.version}` : configured.trim();
  return ua ? { 'user-agent': ua } : {};
}
