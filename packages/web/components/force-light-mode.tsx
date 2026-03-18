import { useMountEffect } from "../hooks/useMountEffect";

export function ForceLightMode() {
  useMountEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");

    return () => {
      document.documentElement.classList.remove("light");
    };
  });

  return null;
}
