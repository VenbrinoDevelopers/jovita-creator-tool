#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { buildCommand } from './commands/build.js';
import { verifyCommand } from './commands/verify.js';
import { initCommand } from './commands/init.js';
import { lintCommand } from './commands/lint.js';
import { infoCommand } from './commands/info.js';
import { devCommand } from './commands/dev.js';
import { connectCommand } from './commands/connect.js';
import { submitCommand } from './commands/submit.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import { syncCommand } from './commands/sync.js';
import { providersCommand } from './commands/providers.js';

const program = new Command();

const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
program.name('jov').description('Build, test, and submit Jovita apps').version(packageVersion);

program.addCommand(buildCommand);
program.addCommand(verifyCommand);
program.addCommand(initCommand);
program.addCommand(lintCommand);
program.addCommand(infoCommand);
program.addCommand(devCommand);
program.addCommand(connectCommand);
program.addCommand(submitCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(syncCommand);
program.addCommand(providersCommand);

await program.parseAsync();
