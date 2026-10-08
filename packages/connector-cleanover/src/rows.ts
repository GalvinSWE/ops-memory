import type { SourceEvent, SourceSubject } from '@ops-memory/core';

/**
 * Turning CleanOver rows into ops-memory records. Kept free of the database so it can be tested on
 * plain objects. Personal fields (guest names, who wrote a comment) are never selected, so they
 * cannot reach a model.
 */

export const SOURCES = ['maintenance_ticket', 'maintenance_comment', 'review'] as const;
export type CleanoverSource = (typeof SOURCES)[number];

export const CONNECTOR_NAME = 'cleanover';

export interface UnitRow {
  id: string;
  alias: string;
  address: string | null;
  business_id: string;
}

export interface TicketRow {
  id: string;
  unit_id: string;
  name: string | null;
  description: string | null;
  comment: string | null;
  status_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CommentRow {
  id: string;
  unit_id: string;
  ticket_id: string;
  ticket_name: string | null;
  content: string | null;
  created_at: Date;
}

export interface ReviewRow {
  id: string;
  unit_id: string;
  overall_rating: number | null;
  review_text: string | null;
  private_feedback: string | null;
  submitted_at: Date | null;
  created_at: Date;
}

export type UrlBuilder = (record: { source: CleanoverSource; id: string; unitId: string; ticketId?: string }) => string | undefined;

const clean = (s: string | null | undefined) => (s ?? '').replace(/\r\n/g, '\n').trim();
const iso = (d: Date) => d.toISOString();

export const unitToSubject = (row: UnitRow): SourceSubject => ({
  type: 'unit',
  id: row.id,
  name: row.alias,
  connector: CONNECTOR_NAME,
  meta: { businessId: row.business_id }
});

export function ticketToEvent(row: TicketRow, url?: UrlBuilder): SourceEvent | null {
  const parts = [
    `Maintenance ticket: ${clean(row.name) || '(no title)'}`,
    row.status_name ? `Status: ${clean(row.status_name)}` : '',
    clean(row.description),
    clean(row.comment)
  ].filter(Boolean);
  if (!clean(row.description) && !clean(row.comment) && !clean(row.name)) return null;
  const link = url?.({ source: 'maintenance_ticket', id: row.id, unitId: row.unit_id });
  return {
    id: `maintenance_ticket:${row.id}`,
    source: 'maintenance_ticket',
    subject: { type: 'unit', id: row.unit_id },
    occurredAt: iso(row.created_at),
    text: parts.join('\n'),
    ...(link ? { url: link } : {}),
    meta: { ticketId: row.id }
  };
}

export function commentToEvent(row: CommentRow, url?: UrlBuilder): SourceEvent | null {
  const content = clean(row.content);
  if (content.length < 3) return null;
  const link = url?.({ source: 'maintenance_comment', id: row.id, unitId: row.unit_id, ticketId: row.ticket_id });
  return {
    id: `maintenance_comment:${row.id}`,
    source: 'maintenance_comment',
    subject: { type: 'unit', id: row.unit_id },
    occurredAt: iso(row.created_at),
    text: `Comment on maintenance ticket "${clean(row.ticket_name) || '(no title)'}":\n${content}`,
    ...(link ? { url: link } : {}),
    meta: { ticketId: row.ticket_id }
  };
}

export function reviewToEvent(row: ReviewRow, url?: UrlBuilder): SourceEvent | null {
  const text = clean(row.review_text);
  const feedback = clean(row.private_feedback);
  if (!text && !feedback) return null;
  const parts = [
    row.overall_rating != null ? `Guest review, overall rating ${row.overall_rating}` : 'Guest review',
    text ? `Public review:\n${text}` : '',
    feedback ? `Private feedback to the host:\n${feedback}` : ''
  ].filter(Boolean);
  const link = url?.({ source: 'review', id: row.id, unitId: row.unit_id });
  return {
    id: `review:${row.id}`,
    source: 'review',
    subject: { type: 'unit', id: row.unit_id },
    occurredAt: iso(row.submitted_at ?? row.created_at),
    text: parts.join('\n\n'),
    ...(link ? { url: link } : {})
  };
}
