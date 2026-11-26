try {
  const response = await fetch('http://127.0.0.1:3000/ops/ready', {
    signal: AbortSignal.timeout(2000),
  });
  if (response.status !== 200) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
