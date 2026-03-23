import { useMountEffect } from "../hooks/useMountEffect";

export function ForceLightMode() {
  useMountEffect(() => {
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add("light");

    return () => {
      document.documentElement.classList.remove("light");
      const theme = localStorage.getItem("codecast-theme") || "light";
      document.documentElement.classList.add(theme);
    };
  });

  return null;
}
