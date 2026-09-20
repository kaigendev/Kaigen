import { useLayoutEffect, useRef, useState } from "react";

export function ChatImagePreview({ src, name, onGeometryChange }: {
  src: string;
  name: string;
  onGeometryChange: () => void;
}) {
  const [loaded, setLoaded] = useState<{ src: string; portrait: boolean } | null>(null);
  const onGeometryChangeRef = useRef(onGeometryChange);
  onGeometryChangeRef.current = onGeometryChange;
  const portrait = loaded?.src === src && loaded.portrait;
  useLayoutEffect(() => {
    if (loaded?.src === src) onGeometryChangeRef.current();
  }, [loaded, src]);
  return <img src={src} alt={name} data-orientation={portrait ? "portrait" : "landscape"} onLoad={(event) => {
    const image = event.currentTarget;
    setLoaded({ src, portrait: image.naturalHeight > image.naturalWidth });
  }} />;
}
