import { HealthBar } from "./components/HealthBar";
import { NewProjectForm } from "./components/NewProjectForm";
import { ProjectList } from "./components/ProjectList";
import { ProjectView } from "./components/ProjectView";
import { homeHref, useRoute } from "./lib/route";

export function App() {
  const route = useRoute();
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-3">
        <a href={homeHref} className="block text-3xl font-extrabold tracking-tight">VIDEO STUDIO</a>
        <HealthBar />
      </header>
      {route.name === "home" ? <><NewProjectForm /><ProjectList /></> : <ProjectView key={route.id} id={route.id} />}
    </div>
  );
}
