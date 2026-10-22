import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import type * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { m } from "@/lib/i18n";

/**
 * Drag and drop of rules (one or more SortableContexts inside), with the screen reader texts.
 * `position` is an id's 1-based place; `onMove` gets the dragged id and the one it was dropped on.
 */
export function SortableList({
  position,
  onMove,
  activationDistance,
  modifiers,
  children,
}: {
  position: (id: UniqueIdentifier) => number;
  onMove: (from: UniqueIdentifier, to: UniqueIdentifier) => void;
  /** Pixels the pointer moves before a drag starts, so clicks inside rows stay clicks. */
  activationDistance?: number;
  modifiers?: Modifier[];
  children: React.ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const sensors = useSensors(
    useSensor(
      PointerSensor,
      activationDistance ? { activationConstraint: { distance: activationDistance } } : undefined,
    ),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Keyboard moves scroll the page along; smoothly unless motion is reduced.
      scrollBehavior: reducedMotion ? "auto" : "smooth",
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={modifiers}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onMove(active.id, over.id);
      }}
      accessibility={{
        screenReaderInstructions: { draggable: m.site_rule_drag_instructions() },
        announcements: {
          onDragStart: ({ active }) => m.site_rule_drag_start({ index: position(active.id) }),
          onDragOver: ({ active, over }) =>
            over
              ? m.site_rule_drag_over({ index: position(active.id), position: position(over.id) })
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? m.site_rule_drag_end({ index: position(active.id), position: position(over.id) })
              : m.site_rule_drag_cancel({ index: position(active.id) }),
          onDragCancel: ({ active }) => m.site_rule_drag_cancel({ index: position(active.id) }),
        },
      }}
    >
      {children}
    </DndContext>
  );
}

/** A row of a SortableList: announced as a rule, carried without a transition when motion is reduced. */
export function useSortableRow(id: UniqueIdentifier) {
  const reducedMotion = useReducedMotion();
  return useSortable({
    id,
    attributes: { roleDescription: m.site_rule_role() },
    transition: reducedMotion ? null : undefined,
  });
}
