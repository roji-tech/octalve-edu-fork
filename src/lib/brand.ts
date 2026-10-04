// Octalve Edu's brand strings — one of only TWO per-repo brand files (the other is
// app/brand.css, the colours). The shared UI reads everything brand-specific from
// here, so the components stay code-identical with AlEemaan's.
//
// Copy is the design artifact's ("Octalve Edu & AlEemaan — UI Design").

export const brand = {
  name: "Octalve Edu",
  /// Shown under the logo on the compact (phone) sign-in header.
  tagline: "Solo or SaaS — sign in to your dashboard",
  description: "School management platform.",
  login: {
    headline: "Run every campus from one dashboard.",
    blurb: "Solo or SaaS — Octalve Edu adapts to how your school actually operates.",
    points: [
      "Multi-campus & multi-tenant ready",
      "Role-based staff permissions",
      "Self-hosted or fully managed",
    ],
  },
  /// What the artifact draws as "Branches" is, in this product's data model, a Campus.
  place: { singular: "campus", plural: "campuses", Singular: "Campus", Plural: "Campuses" },
} as const;
