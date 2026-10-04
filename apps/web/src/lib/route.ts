import { useEffect, useState } from "react";

export type Route = { name: "home" } | { name: "project"; id: string };

function parse(hash: string): Route {
  const match = /^#\/p\/([a-z0-9-]+)$/.exec(hash);
  return match?.[1] ? { name: "project", id: match[1] } : { name: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const projectHref = (id: string) => `#/p/${id}`;
export const homeHref = "#/";
