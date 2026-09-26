import { useEffect } from 'react';
import { useQuery } from '@apollo/client/react';
import { Link } from 'react-router-dom';

import { PLACEMENT_OPTIONS_QUERY } from '../work/queries';
import type { PlacementOptionsQueryData } from '../work/types';
import { noMilestonePlacement, type CreatePlacement, type PlaceableProject, type PlacementSource } from '../work/placement';

interface PlacementPickerProps {
  projects: Array<PlaceableProject & { name: string }>;
  value: CreatePlacement | null;
  source: PlacementSource | null;
  disabled?: boolean;
  onChange: (placement: CreatePlacement | null) => void;
}

const FINISHED = new Set(['COMPLETED', 'CANCELED']);

/**
 * Where new work goes (INV-744), in two steps as in Linear: the project, then
 * the location inside it — "No milestone" first, then its open milestones and
 * epics. Changing the project starts again at "No milestone".
 */
export function PlacementPicker({ projects, value, source, disabled, onChange }: PlacementPickerProps) {
  const placeable = projects.filter((project) => project.identifier);
  const repository = value?.repository ?? '';
  const { data, loading } = useQuery<PlacementOptionsQueryData, { repository: string }>(PLACEMENT_OPTIONS_QUERY, {
    variables: { repository },
    skip: !repository,
  });
  const containers = [...(data?.milestones?.nodes ?? []), ...(data?.epics?.nodes ?? [])].filter(
    (option) => !FINISHED.has(option.state?.type ?? ''),
  );
  const project = placeable.find((candidate) => candidate.repository === repository);
  // A remembered milestone may have been finished or removed since.
  const knownLocation =
    !value || value.parentLabel || value.parentId === project?.identifier || containers.some((option) => option.id === value.parentId);
  const stale = Boolean(data) && !loading && !knownLocation && Boolean(project?.identifier);
  useEffect(() => {
    if (stale && project?.identifier) onChange({ repository, parentId: project.identifier });
  }, [stale, project?.identifier, repository, onChange]);

  if (placeable.length === 0) {
    return (
      <p className="placement-picker__empty" role="note">
        New work goes under a project. <Link to="/projects">Create a project</Link> first.
      </p>
    );
  }

  return (
    <div className="placement-picker" role="group" aria-label="Where it belongs">
      <label className="field-stack">
        <span>
          Project
          {source === 'last' ? <span className="placement-picker__hint"> · Last used</span> : null}
        </span>
        <select
          aria-label="Project"
          value={repository}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value ? noMilestonePlacement(placeable, event.target.value) : null)}
        >
          <option value="">Choose a project</option>
          {placeable.map((candidate) => (
            <option key={candidate.repository} value={candidate.repository}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field-stack">
        <span>Location</span>
        <select
          aria-label="Location"
          value={value?.parentId ?? ''}
          disabled={disabled || !repository}
          onChange={(event) => onChange({ repository, parentId: event.target.value })}
        >
          {!repository ? <option value="">Choose a project first</option> : null}
          {value?.parentLabel ? <option value={value.parentId}>{value.parentLabel}</option> : null}
          {project?.identifier ? <option value={project.identifier}>No milestone</option> : null}
          {containers.map((option) => (
            <option key={option.id} value={option.id}>
              {option.kind === 'EPIC' ? 'Epic · ' : ''}
              {option.identifier} — {option.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
