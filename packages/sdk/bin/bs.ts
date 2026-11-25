#!/usr/bin/env node
import { runCli } from '../src/cli.ts';

const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.exitCode = await runCli(process.argv.slice(2), { signal: cancellation.signal });
