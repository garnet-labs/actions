try {
  const response = await fetch("https://nodejs.org/dist/index.json", {
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    const releases = await response.json();
    const major = process.versions.node.split(".")[0];
    const hasLtsRelease = releases.some(
      ({ version, lts }) => version.startsWith(`v${major}.`) && lts,
    );
    if (!hasLtsRelease) {
      console.warn(`Warning: Node.js ${major} has no LTS release. Use an LTS major for development.`);
    }
  }
} catch {
  // This advisory check must never prevent installation.
}
