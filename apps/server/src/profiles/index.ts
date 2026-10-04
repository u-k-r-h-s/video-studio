import { FormatProfileSchema, type FormatProfile } from "@studio/shared";
import { HttpError } from "../errors";
import { cinematicAnimatedShort } from "./cinematicAnimatedShort";
import { motionComic } from "./motionComic";

/** Registry of available format profiles. Adding a video type = adding an entry here (data), not new pipeline code. */
export class ProfileRegistry {
  private readonly profiles = new Map<string, FormatProfile>();

  constructor(profiles: FormatProfile[] = [motionComic, cinematicAnimatedShort]) {
    for (const p of profiles) this.register(p);
  }

  register(profile: FormatProfile): void {
    this.profiles.set(profile.id, FormatProfileSchema.parse(profile));
  }

  get(id: string): FormatProfile {
    const p = this.profiles.get(id);
    if (!p) throw new HttpError(400, "unknown_profile", `Unknown format profile "${id}". Available: ${[...this.profiles.keys()].join(", ")}`);
    return p;
  }

  list(): FormatProfile[] {
    return [...this.profiles.values()];
  }
}
