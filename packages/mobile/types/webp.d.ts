// The session faces import the web package's WebP art
// (packages/web/components/org/avatars). One import, two values: Vite hands the
// web a URL string, Metro hands the phone an asset number. The web module types
// its map as strings, so the phone's program takes the import untyped and
// MobileSessionFace casts the map to image sources in one place.
declare module '*.webp' {
  const asset: any;
  export default asset;
}
