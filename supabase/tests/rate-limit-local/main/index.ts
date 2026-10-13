// Minimal edge-runtime main service for the rate-limit local e2e: routes
// /<function>/... to a user worker for /home/deno/functions/<function>
// (the same shape as the upstream self-hosted router, without JWT checks).
Deno.serve(async (req: Request) => {
  const name = new URL(req.url).pathname.split("/")[1];
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    return new Response(JSON.stringify({ msg: "missing function name" }), { status: 400 });
  }
  try {
    // deno-lint-ignore no-explicit-any
    const worker = await (globalThis as any).EdgeRuntime.userWorkers.create({
      servicePath: `/home/deno/functions/${name}`,
      memoryLimitMb: 150,
      workerTimeoutMs: 60_000,
      noModuleCache: false,
      importMapPath: null,
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(req);
  } catch (e) {
    return new Response(JSON.stringify({ msg: String(e) }), { status: 500 });
  }
});
