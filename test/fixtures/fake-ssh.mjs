// Stand-in for `ssh` in offline tests: runs the remote command locally with `sh -c`, HOME set to
// FAKE_SSH_HOME, and appends its argv to FAKE_SSH_LOG. Host names select behaviour:
//   down          exit 255 like an unreachable host, without running anything
//   drop-start    run the command, but lose the reply to the first exec_start (exit 255)
//   anything else run the command
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(argv)}\n`);
let i = 0;
while (i < argv.length && argv[i] !== '--') i += argv[i] === '-o' ? 2 : 1;
const [host, command] = argv.slice(i + 1);
if (host === 'down') {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`);
  process.exit(255);
}
const input = readFileSync(0);
const run = spawnSync('sh', ['-c', command], { input, env: { ...process.env, HOME: process.env.FAKE_SSH_HOME }, maxBuffer: 1 << 28 });
const marker = join(process.env.FAKE_SSH_HOME, '.dropped-start');
if (host === 'drop-start' && !existsSync(marker) && input.toString().includes('"exec_start"') && run.status === 0) {
  writeFileSync(marker, '');
  process.stderr.write('Connection to drop-start closed by remote host.\n');
  process.exit(255);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
