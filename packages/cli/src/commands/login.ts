import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CreatorApi } from '../lib/creator-api.js';
import { clearSession, creatorApiUrl, readSession, saveSession } from '../lib/creator-session.js';

export const loginCommand = new Command('login')
  .description('Sign in to Jovita with a code sent to your creator email')
  .option('--email <email>', 'Creator account email')
  .action(async (options) => {
    const prompts = createInterface({ input: stdin, output: stdout });
    try {
      const email = String(options.email || await prompts.question('Creator email: ')).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid creator email.');
      const api = new CreatorApi();
      const challenge = await api.publicRequest<{ otpSessionId: string }>('/creator-auth/email/request', { email });
      if (!challenge.otpSessionId) throw new Error('Jovita did not return an email challenge.');
      stdout.write(`Check ${email} for a six-digit code.\n`);
      const code = (await prompts.question('Code: ')).trim();
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your email.');
      const session = await api.publicRequest<{ accessToken: string; refreshToken: string }>(
        '/creator-auth/email/verify', { email, otpSessionId: challenge.otpSessionId, code });
      if (!session.accessToken || !session.refreshToken) throw new Error('Jovita did not return a creator session.');
      await saveSession({ apiUrl: creatorApiUrl(), email, ...session });
      stdout.write(`Signed in as ${email}.\n`);
    } finally { prompts.close(); }
  });

export const logoutCommand = new Command('logout')
  .description('Remove the saved creator session from this computer')
  .action(async () => {
    await clearSession();
    stdout.write('Local creator session removed.\n');
  });

export const whoamiCommand = new Command('whoami')
  .description('Show the saved creator account for this API')
  .action(async () => {
    const session = await readSession();
    stdout.write(session ? `${session.email} (${session.apiUrl})\n` : 'No saved creator session. Run jov login.\n');
  });
