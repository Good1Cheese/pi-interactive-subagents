for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_AUTONOMY_")) {
    delete process.env[key];
  }
}
