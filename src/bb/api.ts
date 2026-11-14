import { BlackboardError, type BlackboardClient } from './client.js';

export interface CourseRef {
  id: string;
  name: string;
  code?: string;
  role?: string;
  ultra?: string;
  available?: boolean;
  organization?: boolean;
}

export interface Assignment {
  contentId: string;
  title: string;
  columnId?: string;
  dueDate?: string;
  pointsPossible?: number;
  attemptsAllowed?: number;
  submissionStatus?: string;
  lastAttemptId?: string;
  score?: number;
  instructions?: string;
  handler: string;
  parentId?: string;
  visible?: boolean;
}

export interface Forum {
  contentId: string;
  boardId: string;
  forumId: string;
  title: string;
  description?: string;
  available: boolean;
  allowNewThreads: boolean;
  allowAttachments: boolean;
  allowEditOwn: boolean;
  allowDeleteOwn: boolean;
  unread?: number;
}

export interface CalendarItem {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  location?: string;
  calendarId?: string;
  userCreated: boolean;
  itemSourceType?: string;
  due?: boolean;
  courseId?: string;
}

type Json = Record<string, any>;

export function htmlToText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bodyText(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return htmlToText(body);
  const record = body as Json;
  return [record.rawText, record.formattedText, record.displayText]
    .map((value) => typeof value === 'string' ? htmlToText(value) : '')
    .find((value) => value.trim()) ?? '';
}

/** Ultra embeds the assessment one level below the deployment's test settings. */
export function assessmentFrom(item: Json): Json {
  const detail = item.contentDetail ?? {};
  const link = detail['resource/x-bb-asmt-test-link'] ?? detail['resource/x-bb-assignment'] ?? {};
  return link.test?.assessment ?? link.assessment ?? {};
}

export function assignmentInstructions(item: Json): string {
  const detail = item.contentDetail ?? {};
  const link = detail['resource/x-bb-asmt-test-link'] ?? detail['resource/x-bb-assignment'] ?? {};
  const assessment = assessmentFrom(item);
  return [assessment.instructions, link.test?.instructions, link.instructions,
    assessment.description, item.body, item.description]
    .map(bodyText).find((value) => value.trim()) ?? '';
}

function unwrap<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  const record = page as Json | undefined;
  return Array.isArray(record?.results) ? (record.results as T[]) : [];
}

/** Missing/forbidden optional features are expected; outages and expired sessions are not. */
export async function optionalRead<T>(request: Promise<T>, fallback: T): Promise<T> {
  try { return await request; }
  catch (error) {
    if (error instanceof BlackboardError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

export class BlackboardApi {
  private readonly client: BlackboardClient;

  constructor(client: BlackboardClient) {
    this.client = client;
  }

  get raw(): BlackboardClient {
    return this.client;
  }

  me(): Promise<Json> {
    return this.client.get<Json>('/users/me', { cacheTtlMs: this.client.config.cacheTtlMs ?? 15_000 });
  }

  async courses(force = false): Promise<CourseRef[]> {
    const memberships = await this.client.getAll<Json>(
      this.client.mode === 'internal' ? '/users/me/memberships' : '/users/me/courses', {
      query: { expand: 'course' },
      cacheTtlMs: force ? 0 : this.client.config.cacheTtlMs ?? 15_000,
    });

    return memberships.map((membership) => {
      const course = (membership.course ?? {}) as Json;
      return {
        id: String(course.id ?? membership.courseId ?? ''),
        name: String(course.name ?? course.displayName ?? ''),
        code: (course.courseId ?? course.externalId) as string | undefined,
        role: membership.role ?? membership.courseRoleId,
        ultra: course.ultraStatus as string | undefined,
        available: course.isAvailable !== false,
        organization: course.serviceLevelType === 'COMMUNITY' || course.isOrganization === true,
      };
    });
  }

  /** Accept `_123_1`, an exact course code, an exact name, or a unique substring. */
  async resolveCourse(ref: string): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('courseId must not be empty. Use bb_list_courses to see ids.');
    if (/^_.+_\d+$/.test(trimmed)) return trimmed;

    const courses = await this.courses();
    const lower = trimmed.toLowerCase();
    const exact = courses.find(
      (course) => course.code?.toLowerCase() === lower || course.name.toLowerCase() === lower,
    );
    if (exact) return exact.id;

    const partial = courses.filter(
      (course) =>
        course.name.toLowerCase().includes(lower) || course.code?.toLowerCase().includes(lower),
    );
    if (partial.length === 1) return partial[0]!.id;
    if (partial.length > 1) {
      throw new Error(
        `Course "${ref}" is ambiguous. Matches: ${partial
          .slice(0, 8)
          .map((course) => `${course.id} (${course.code ?? course.name})`)
          .join(', ')}`,
      );
    }
    throw new Error(`No enrolled course matches "${ref}". Use bb_list_courses to see ids.`);
  }

  course(courseId: string): Promise<Json> {
    return this.client.get<Json>(`/courses/${encodeURIComponent(courseId)}`);
  }

  content(courseId: string, parentId = 'ROOT', limit = 100): Promise<Json> {
    return this.client.get<Json>(
      `/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(parentId)}/children`,
      { query: { limit }, cacheTtlMs: this.client.config.cacheTtlMs ?? 15_000 },
    );
  }

  /** Recursively flatten the outline (and the INTERACTIVE root) into items. */
  async walkContent(courseId: string): Promise<Json[]> {
    const items: Json[] = [];
    const queue: string[] = ['ROOT', 'INTERACTIVE'];
    const seen = new Set<string>();
    const seenItems = new Set<string>();

    while (queue.length) {
      const parents: string[] = [];
      while (queue.length && parents.length < (this.client.config.concurrency ?? 4)) {
        const parent = queue.shift()!;
        if (seen.has(parent)) continue;
        if (seen.size >= 1000) throw new Error('Course outline exceeds 1000 folders; browse a specific folder.');
        seen.add(parent);
        parents.push(parent);
      }
      const pages = await Promise.all(parents.map((parent) => {
        const request = this.client.getAll<Json>(
          `/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(parent)}/children`,
          { query: { limit: 200 }, cacheTtlMs: this.client.config.cacheTtlMs ?? 15_000 },
        );
        return parent === 'INTERACTIVE' ? optionalRead(request, []) : request;
      }));
      for (const item of pages.flat()) {
        if (item.id && seenItems.has(String(item.id))) continue;
        if (item.id) seenItems.add(String(item.id));
        items.push(item);
        const handler = String(item.contentHandler ?? '');
        const isContainer =
          handler.includes('folder') ||
          handler.includes('lesson') ||
          handler === 'resource/x-bb-lesson';
        if (isContainer && item.id) queue.push(String(item.id));
      }
    }
    return items;
  }

  async assignments(courseId: string): Promise<Assignment[]> {
    const [items, columns, grades] = await Promise.all([
      this.walkContent(courseId),
      optionalRead(this.gradeColumns(courseId), []),
      optionalRead(this.myGrades(courseId), []),
    ]);
    return this.summarizeAssignments(items, columns, grades);
  }

  /** Fetch one assignment without walking the entire course. */
  async assignment(courseId: string, contentId: string): Promise<{ item: Json; summary?: Assignment }> {
    const [item, columns, grades] = await Promise.all([
      this.client.get<Json>(`/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}`),
      optionalRead(this.gradeColumns(courseId), []),
      optionalRead(this.myGrades(courseId), []),
    ]);
    return { item, summary: this.summarizeAssignments([item], columns, grades)[0] };
  }

  private summarizeAssignments(items: Json[], columns: Json[], grades: Json[]): Assignment[] {
    const gradesByColumn = new Map<string, Json>();
    for (const grade of grades) gradesByColumn.set(String(grade.columnId), grade);
    const columnsById = new Map<string, Json>();
    for (const column of columns) columnsById.set(String(column.id), column);

    const assignments: Assignment[] = [];
    for (const item of items) {
      const handler = String(item.contentHandler ?? '');
      if (!handler.includes('asmt-test-link') && handler !== 'resource/x-bb-assignment') continue;

      const detail = (item.contentDetail ?? {}) as Json;
      const link = (detail['resource/x-bb-asmt-test-link'] ?? detail['resource/x-bb-assignment'] ?? {}) as Json;
      const test = (link.test ?? {}) as Json;
      const column = (test.gradingColumn ?? link.gradingColumn ?? {}) as Json;
      const columnId = column.id as string | undefined;
      const grade = columnId ? gradesByColumn.get(columnId) : undefined;
      const fullColumn = columnId ? columnsById.get(columnId) : undefined;

      assignments.push({
        contentId: String(item.id),
        title: String(item.title ?? test.title ?? ''),
        columnId,
        dueDate: (column.dueDate ?? item.genericReadOnlyData?.dueDate ?? undefined) as string | undefined,
        pointsPossible: (column.possible ?? fullColumn?.possible) as number | undefined,
        attemptsAllowed: (column.multipleAttempts ?? test.deploymentSettings?.attemptCount) as
          | number
          | undefined,
        submissionStatus: grade
          ? grade.lastAttemptId
            ? 'submitted'
            : 'not_submitted'
          : undefined,
        lastAttemptId: grade?.lastAttemptId as string | undefined,
        score: (grade?.score ?? column.score) as number | undefined,
        instructions: assignmentInstructions(item),
        handler,
        parentId: item.parentId as string | undefined,
        visible: item.visibility === 'VISIBLE',
      });
    }
    return assignments;
  }

  async gradeColumns(courseId: string): Promise<Json[]> {
    return this.client.getAll<Json>(`/courses/${encodeURIComponent(courseId)}/gradebook/columns`, {
        query: { limit: 200 },
      });
  }

  async myGrades(courseId: string): Promise<Json[]> {
    const me = await this.me();
    return this.client.getAll<Json>(`/courses/${encodeURIComponent(courseId)}/gradebook/grades`, {
        query: { userId: me.id, limit: 200 },
      });
  }

  async columnAttempts(courseId: string, columnId: string): Promise<Json> {
    return this.client.get(
      `/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(columnId)}/attempts`,
    );
  }

  async attempt(courseId: string, attemptId: string): Promise<Json> {
    return this.client.get(
      `/courses/${encodeURIComponent(courseId)}/gradebook/attempts/${encodeURIComponent(attemptId)}`,
    );
  }

  /** Forums are content items under INTERACTIVE with a forum id in contentDetail. */
  async forums(courseId: string): Promise<Forum[]> {
    const page = await this.content(courseId, 'INTERACTIVE', 200).catch(() => undefined);
    const forums: Forum[] = [];

    for (const item of unwrap<Json>(page)) {
      if (String(item.contentHandler) !== 'resource/x-bb-forumlink') continue;
      const link = (item.contentDetail?.['resource/x-bb-forumlink'] ?? {}) as Json;
      const properties = (link.properties ?? {}) as Json;
      const match = String(item.contentDetailUrl ?? '').match(
        /discussionboards\/([^/]+)\/forums\/([^/?]+)/,
      );
      const boardId = match?.[1] ?? String(link.conferenceId ?? 'default');
      const forumId = match?.[2] ?? String(link.id ?? '');
      if (!forumId) continue;

      forums.push({
        contentId: String(item.id),
        boardId,
        forumId,
        title: String(item.title ?? ''),
        description: bodyText(item.description),
        available: item.visibility !== 'HIDDEN',
        allowNewThreads: properties.allowMembersToCreateNewThreads !== false,
        allowAttachments: properties.allowAttachment !== false,
        allowEditOwn: properties.allowAuthorToEditOwnPublishedPosts !== false,
        allowDeleteOwn: properties.allowAuthorToDeleteOwnPosts !== false,
        unread: undefined,
      });
    }

    return forums;
  }

  async forumMessages(courseId: string, boardId: string, forumId: string): Promise<Json[]> {
    const page = await this.client.get(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages`,
      { query: { limit: 100 } },
    );
    return unwrap<Json>(page);
  }

  async replies(courseId: string, boardId: string, forumId: string, messageId: string): Promise<Json[]> {
    const page = await this.client.get(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages/${encodeURIComponent(messageId)}/replies`,
      { query: { limit: 100 } },
    );
    return unwrap<Json>(page);
  }

  async createThread(
    courseId: string,
    forumId: string,
    subject: string,
    body: string,
    boardId = 'default',
  ): Promise<Json> {
    const me = await this.me();
    const now = new Date().toISOString();
    return this.client.post(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages`,
      {
        forumId,
        userId: me.id,
        lifecycle: 'PUBLISHED',
        postedName: me.preferredDisplayName ?? me.userName,
        subject,
        body: { rawText: body, displayText: '' },
        postDate: now,
        editDate: now,
        postAsAnonymous: false,
      },
    );
  }

  async replyToMessage(
    courseId: string,
    forumId: string,
    parentId: string,
    body: string,
    boardId = 'default',
  ): Promise<Json> {
    const me = await this.me();
    const now = new Date().toISOString();
    return this.client.post(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages/${encodeURIComponent(parentId)}/replies`,
      {
        parentId,
        forumId,
        userId: me.id,
        lifecycle: 'PUBLISHED',
        postedName: me.preferredDisplayName ?? me.userName,
        subject: null,
        body: { rawText: body, displayText: '' },
        postDate: now,
        editDate: now,
        postAsAnonymous: false,
      },
    );
  }

  async editMessage(
    courseId: string,
    forumId: string,
    messageId: string,
    body: string,
    boardId = 'default',
  ): Promise<Json> {
    return this.client.patch(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages/${encodeURIComponent(messageId)}`,
      { body: { rawText: body, displayText: '' }, editDate: new Date().toISOString() },
    );
  }

  async deleteMessage(
    courseId: string,
    forumId: string,
    messageId: string,
    boardId = 'default',
  ): Promise<void> {
    await this.client.delete(
      `/courses/${encodeURIComponent(courseId)}/discussionboards/${encodeURIComponent(boardId)}/forums/${encodeURIComponent(forumId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async conversations(courseId: string, limit = 50): Promise<Json[]> {
    return unwrap<Json>(
      await this.client.get(`/courses/${encodeURIComponent(courseId)}/conversations`, {
        query: { limit },
      }),
    );
  }

  async conversationMessages(courseId: string, conversationId: string): Promise<Json[]> {
    return unwrap<Json>(
      await this.client.get(
        `/courses/${encodeURIComponent(courseId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { query: { limit: 100 } },
      ),
    );
  }

  async messageSummary(): Promise<Json[]> {
    return unwrap<Json>(await this.client.get('/messages/summary'));
  }

  async sendMessage(
    courseId: string,
    participantIds: string[],
    body: string,
    canBeRepliedTo = true,
  ): Promise<Json> {
    return this.client.post(
      `/courses/${encodeURIComponent(courseId)}/conversations`,
      {
        participantIds,
        messages: [{ body: { rawText: body, displayText: '' } }],
        canBeRepliedTo,
      },
      { query: { sendEmailToParticipants: false } },
    );
  }

  async replyConversation(courseId: string, conversationId: string, body: string): Promise<Json> {
    return this.client.post(
      `/courses/${encodeURIComponent(courseId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: { rawText: body, displayText: '' } },
    );
  }

  async calendar(since?: string, until?: string): Promise<CalendarItem[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (since) query.since = since;
    if (until) query.until = until;
    const page = await this.client.get('/calendars/calendarItems', { query });
    return unwrap<Json>(page).map((item) => this.toCalendarItem(item));
  }

  private toCalendarItem(item: Json): CalendarItem {
    return {
      id: String(item.itemSourceId ?? item.id ?? ''),
      title: String(item.title ?? ''),
      startDate: item.startDate ?? undefined,
      endDate: item.endDate ?? undefined,
      description: bodyText(item.description),
      location: item.location ?? undefined,
      calendarId: item.calendarId ?? undefined,
      userCreated: item.userCreated === true,
      itemSourceType: item.itemSourceType ?? undefined,
      due: item.dynamicCalendarItemProps?.gradable === true || item.dynamicCalendarItemProps?.eventType === 'Assignment',
      courseId: item.calendarId && String(item.calendarId).startsWith('_') ? item.calendarId : undefined,
    };
  }

  async createEvent(input: {
    title: string;
    startDate: string;
    endDate: string;
    description?: string;
    location?: string;
    calendarId?: string;
  }): Promise<Json> {
    const me = await this.me();
    return this.client.post(`/users/${encodeURIComponent(me.id)}/calendarItems`, {
      title: input.title,
      calendarId: input.calendarId ?? 'PERSONAL',
      startDate: input.startDate,
      endDate: input.endDate,
      recurRules: null,
      description: input.description ?? '',
      location: input.location ?? '',
    });
  }

  /**
   * Personal calendar items live under the user with a Java type segment:
   * /users/{id}/calendarItems/blackboard.data.calendar.CalendarEntry/{itemId}
   */
  private async calendarItemPath(itemId: string): Promise<string> {
    const me = await this.me();
    return `/users/${encodeURIComponent(me.id)}/calendarItems/blackboard.data.calendar.CalendarEntry/${encodeURIComponent(itemId)}`;
  }

  async updateEvent(
    itemId: string,
    patch: { title?: string; startDate?: string; endDate?: string; description?: string; location?: string },
  ): Promise<Json> {
    return this.client.patch(await this.calendarItemPath(itemId), patch);
  }

  async deleteEvent(itemId: string): Promise<void> {
    await this.client.delete(await this.calendarItemPath(itemId));
  }

  async announcements(courseId: string, limit = 50): Promise<Json[]> {
    return unwrap<Json>(
      await this.client.get(`/courses/${encodeURIComponent(courseId)}/announcements`, {
        query: { limit },
      }),
    );
  }

  async groups(courseId: string): Promise<Json[]> {
    return this.client.getAll<Json>(`/courses/${encodeURIComponent(courseId)}/groups`, {
      query: this.client.mode === 'internal'
        ? { expand: 'studentCount,memberships.user,permissions,signUpSheet', membershipAvailable: true }
        : undefined,
    });
  }

  async group(courseId: string, groupId: string): Promise<Json> {
    if (this.client.mode !== 'internal') {
      return this.client.get<Json>(`/courses/${encodeURIComponent(courseId)}/groups/${encodeURIComponent(groupId)}`);
    }
    // Ultra allows students to read expanded groups even when the detail route is admin-only.
    const group = (await this.groups(courseId)).find(group => group.id === groupId);
    if (!group) throw new BlackboardError('Group not found in the accessible course groups.', 404, groupId, {});
    return group;
  }

  async groupMembers(courseId: string, groupId: string): Promise<Json[]> {
    if (this.client.mode !== 'internal') {
      return this.client.getAll<Json>(
        `/courses/${encodeURIComponent(courseId)}/groups/${encodeURIComponent(groupId)}/users`,
        { query: { expand: 'user' } },
      );
    }
    const group = await this.group(courseId, groupId);
    if (!Array.isArray(group.memberships)) {
      throw new Error('Blackboard did not expose group memberships; member count is unknown.');
    }
    return group.memberships;
  }

  async roster(courseId: string): Promise<Json[]> {
    return unwrap<Json>(
      await this.client.get(`/courses/${courseId}/memberships`, {
        query: { limit: 500, expand: 'user' },
      }),
    );
  }

  async profile(): Promise<Json> {
    return this.me();
  }

  async updateProfile(patch: Json): Promise<Json> {
    return this.client.put('/users', patch);
  }

  async rubrics(courseId: string): Promise<Json[]> {
    return unwrap<Json>(await this.client.get(`/courses/${courseId}/rubrics`));
  }

  /** Documented public API: body is a BbML string and contentHandler is a typed object. */
  async createContent(
    courseId: string,
    input: { title: string; parentId?: string; handler?: string; body?: string },
  ): Promise<Json> {
    const handler = input.handler ?? 'resource/x-bb-folder';
    return this.client.post(`/learn/api/public/v1/courses/${courseId}/contents`, {
      title: input.title,
      parentId: input.parentId ?? 'ROOT',
      body: input.body ?? '',
      contentHandler: { [handler]: {} },
    });
  }

  async updateContent(courseId: string, contentId: string, patch: Json): Promise<Json> {
    return this.client.patch(
      `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`,
      patch,
    );
  }

  async deleteContent(courseId: string, contentId: string): Promise<void> {
    await this.client.delete(`/learn/api/public/v1/courses/${courseId}/contents/${contentId}`);
  }

  async createAnnouncement(
    courseId: string,
    input: { title: string; body: string; startDate?: string; endDate?: string },
  ): Promise<Json> {
    return this.client.post(`/learn/api/public/v1/courses/${courseId}/announcements`, {
      title: input.title,
      body: input.body,
      draft: false,
      availability: {
        available: 'Yes',
        ...(input.startDate || input.endDate
          ? {
              duration: {
                type: 'DateRange',
                ...(input.startDate ? { start: input.startDate } : {}),
                ...(input.endDate ? { end: input.endDate } : {}),
              },
            }
          : { duration: { type: 'Permanent' } }),
      },
    });
  }

  async updateAnnouncement(courseId: string, announcementId: string, patch: Json): Promise<Json> {
    return this.client.patch(
      `/learn/api/public/v1/courses/${courseId}/announcements/${announcementId}`,
      patch,
    );
  }

  async deleteAnnouncement(courseId: string, announcementId: string): Promise<void> {
    await this.client.delete(`/learn/api/public/v1/courses/${courseId}/announcements/${announcementId}`);
  }

  async createAssignment(
    courseId: string,
    input: {
      title: string;
      instructions?: string;
      parentId?: string;
      dueDate?: string;
      pointsPossible?: number;
      attemptsAllowed?: number;
    },
  ): Promise<Json> {
    return this.client.post(
      `/learn/api/public/v1/courses/${courseId}/contents/createAssignment`,
      {
        title: input.title,
        instructions: input.instructions ?? '',
        parentId: input.parentId,
        availability: { available: 'Yes' },
        grading: {
          due: input.dueDate,
          attemptsAllowed: input.attemptsAllowed,
          pointsPossible: input.pointsPossible,
        },
      },
    );
  }

  async setGrade(
    courseId: string,
    columnId: string,
    userId: string,
    input: { score?: number; feedback?: string; exempt?: boolean },
  ): Promise<Json> {
    return this.client.patch(
      `/learn/api/public/v1/courses/${courseId}/gradebook/columns/${columnId}/users/${userId}`,
      input,
    );
  }

  async addMember(courseId: string, userId: string, role: string): Promise<Json> {
    return this.client.put(`/learn/api/public/v1/courses/${courseId}/users/${userId}`, {
      courseRoleId: role,
      availability: { available: 'Yes' },
    });
  }

  async updateMember(
    courseId: string,
    userId: string,
    patch: { courseRoleId?: string; available?: boolean },
  ): Promise<Json> {
    return this.client.patch(`/learn/api/public/v1/courses/${courseId}/users/${userId}`, {
      ...(patch.courseRoleId ? { courseRoleId: patch.courseRoleId } : {}),
      ...(patch.available !== undefined
        ? { availability: { available: patch.available ? 'Yes' : 'No' } }
        : {}),
    });
  }

  async removeMember(courseId: string, userId: string): Promise<void> {
    await this.client.delete(`/learn/api/public/v1/courses/${courseId}/users/${userId}`);
  }

  async submitAssignment(
    courseId: string,
    columnId: string,
    input: { text?: string; filePaths?: string[] },
  ): Promise<Json> {
    const fs = await import('node:fs/promises');
    // Validate every attachment before creating an attempt on Blackboard.
    for (const filePath of input.filePaths ?? []) {
      const info = await fs.stat(filePath);
      if (!info.isFile()) throw new Error(`Submission attachment is not a file: ${filePath}`);
      await fs.access(filePath, fs.constants.R_OK);
    }
    const me = await this.me();

    // 1. Create an in-progress attempt owned by the current user.
    const attempt = await this.client.post<Json>(
      `/courses/${courseId}/gradebook/columns/${columnId}/attempts`,
      { userId: me.id, status: 'InProgress' },
    );
    const attemptId = String(attempt.id ?? attempt.attemptId ?? '');
    if (!attemptId) throw new Error('Blackboard did not return an attempt id.');

    try {
      // 2. Attach files (multipart) to the attempt.
      const uploaded: Json[] = [];
      for (const filePath of input.filePaths ?? []) {
        const form = new FormData();
        const data = await fs.readFile(filePath);
        form.append('file', new Blob([data]), filePath.split(/[\\/]/).pop());
        const file = await this.client.request<Json>(
          `/courses/${courseId}/gradebook/columns/${columnId}/attempts/${attemptId}/files`,
          { method: 'POST', form },
        );
        uploaded.push(file);
      }

      // 3. Post the attempt for grading.
      return await this.client.patch(
        `/courses/${courseId}/gradebook/columns/${columnId}/attempts/${attemptId}`,
        {
          status: 'NeedsGrading',
          studentSubmission: { rawText: input.text ?? '', displayText: '' },
          studentSubmissionFiles: uploaded,
          readyToPost: true,
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Submission attempt ${attemptId} was created, but completion was not confirmed. ` +
        `Check this attempt in Blackboard before submitting again. ${reason}`);
    }
  }
}
