/** Keep legacy business settings while adopting a managed instance's runtime boundary. */
export function mergeCpaMigrationConfig(legacy, target) {
  return structuredClone({
    ...target,
    ...legacy,
    server: target.server,
    management: target.management,
    access: target.access,
    oauth: target.oauth,
    requests: {
      ...target.requests,
      ...legacy.requests,
      "proxy-url": target.requests["proxy-url"],
    },
  });
}
