#!/usr/bin/env node
import { Command } from 'commander';
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

const program = new Command();

program.name('jov').description('Build, test, and submit Jovita apps').version('0.1.3');

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

await program.parseAsync();
