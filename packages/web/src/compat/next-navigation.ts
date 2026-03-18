import {
  useNavigate,
  useLocation,
  useSearchParams as useRRSearchParams,
  useParams,
} from "react-router";

export function usePathname(): string {
  return useLocation().pathname;
}

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (path: string) => navigate(path),
    replace: (path: string) => navigate(path, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => window.location.reload(),
    prefetch: (_path: string) => {},
  };
}

export function useSearchParams(): URLSearchParams {
  const [searchParams] = useRRSearchParams();
  return searchParams;
}

export { useParams };

export function redirect(path: string): never {
  window.location.href = path;
  throw new Error("redirect");
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}
