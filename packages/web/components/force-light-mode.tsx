import { useEffect } from "react";

export function ForceLightMode() {
  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");

    return () => {
      document.documentElement.classList.remove("light");
    };
  }, []);

  return null;
}
