import api from './api'

export const adminApi = {
  // Canonical admin tests
  tests: (params, opts) => api.get('admin/tests', { params, ...opts }),
  allTests: (params = {}, opts = {}) => api.get('admin/tests', {
    params: {
      page_size: 100,
      status: 'DRAFT,PUBLISHED,ARCHIVED',
      ...params,
    },
    ...opts,
  }),
  getTest: (id, opts = {}) => api.get(`admin/tests/${id}`, opts),
  createTest: (data) => api.post('admin/tests', data),
  updateTest: (id, data) => api.patch(`admin/tests/${id}`, data),
  publishTest: (id) => api.post(`admin/tests/${id}/publish`),
  archiveTest: (id) => api.post(`admin/tests/${id}/archive`),
  unarchiveTest: (id) => api.post(`admin/tests/${id}/unarchive`),
  duplicateTest: (id) => api.post(`admin/tests/${id}/duplicate`),
  deleteTest: (id) => api.delete(`admin/tests/${id}`),
  downloadTestReport: (id) => api.get(`admin/tests/${id}/report`, { responseType: 'blob' }),

  // Categories
  categories: (opts = {}) => api.get('categories/', opts),
  getCategory: (id) => api.get(`categories/${id}`),
  createCategory: (data) => api.post('categories/', data),
  updateCategory: (id, data) => api.put(`categories/${id}`, data),
  deleteCategory: (id) => api.delete(`categories/${id}`),

  // Grading Scales
  gradingScales: () => api.get('grading-scales/'),
  getGradingScale: (id) => api.get(`grading-scales/${id}`),
  createGradingScale: (data) => api.post('grading-scales/', data),
  updateGradingScale: (id, data) => api.put(`grading-scales/${id}`, data),
  deleteGradingScale: (id) => api.delete(`grading-scales/${id}`),

  // Question Pools
  questionPools: () => api.get('question-pools/'),
  getQuestionPool: (id) => api.get(`question-pools/${id}`),
  createQuestionPool: (data) => api.post('question-pools/', data),
  updateQuestionPool: (id, data) => api.put(`question-pools/${id}`, data),
  getPoolQuestions: (poolId) => api.get(`question-pools/${poolId}/questions`),
  createPoolQuestion: (poolId, data) => api.post(`question-pools/${poolId}/questions`, data),
  updatePoolQuestion: (poolId, questionId, data) => api.put(`question-pools/${poolId}/questions/${questionId}`, data),
  deletePoolQuestion: (poolId, questionId) => api.delete(`question-pools/${poolId}/questions/${questionId}`),
  seedExamFromPool: (poolId, examId, count = 5) =>
    api.post(`question-pools/${poolId}/seed-exam/${examId}`, null, { params: { count } }),
  deleteQuestionPool: (id) => api.delete(`question-pools/${id}`),

  // Schedules
  schedulableTests: (opts) => api.get('schedules/tests', opts),
  schedules: (opts) => api.get('schedules/', opts),
  createSchedule: (data) => api.post('schedules/', data),
  updateSchedule: (id, data) => api.put(`schedules/${id}`, data),
  deleteSchedule: (id) => api.delete(`schedules/${id}`),
  assignSchedule: (data) => api.post('schedules/assign', data),

  // Questions
  getQuestions: (examId, opts = {}) => api.get('questions/', { params: { exam_id: examId }, ...opts }),
  addQuestion: (data) => api.post('questions/', data),
  updateQuestion: (id, data) => api.put(`questions/${id}`, data),
  deleteQuestion: (id) => api.delete(`questions/${id}`),

  // Users
  users: (params, opts) => api.get('users/', { params, ...opts }),
  learnersForScheduling: (params, opts) => api.get('users/learners', { params, ...opts }),
  getUser: (id) => api.get(`users/${id}`),
  createUser: (data) => api.post('users/', data),
  updateUser: (id, data) => api.patch(`users/${id}`, data),
  deleteUser: (id) => api.delete(`users/${id}`),
  resetUserPassword: (id, new_password) => api.post(`users/${id}/reset-password`, { new_password }),
  getMyPreference: (key) => api.get(`users/me/preferences/${key}`),
  updateMyPreference: (key, value) => api.put(`users/me/preferences/${key}`, { value }),

  // Courses
  courses: () => api.get('courses/'),
  getCourse: (id) => api.get(`courses/${id}`),
  createCourse: (data) => api.post('courses/', data),
  updateCourse: (id, data) => api.put(`courses/${id}`, data),
  deleteCourse: (id) => api.delete(`courses/${id}`),

  // Nodes
  nodes: (courseId) => api.get('nodes/', { params: courseId ? { course_id: courseId } : {} }),
  createNode: (data) => api.post('nodes/', data),
  updateNode: (id, data) => api.put(`nodes/${id}`, data),
  deleteNode: (id) => api.delete(`nodes/${id}`),

  // Attempts / Analysis
  attempts: (params, opts) => api.get('attempts/', { params, ...opts }),
  getAttempt: (id, opts) => api.get(`attempts/${id}`, opts),
  importAttempts: (rows) => api.post('attempts/import', rows),
  getAttemptEvents: (attemptId, opts) => api.get(`proctoring/${attemptId}/events`, opts),
  generateReport: (attemptId, { outputFormat = 'html', responseType } = {}) =>
    api.post(`proctoring/${attemptId}/generate-report`, null, {
      params: { output_format: outputFormat },
      responseType: responseType || (outputFormat === 'pdf' ? 'blob' : 'text'),
    }),
  pauseAttempt: (attemptId) => api.post(`proctoring/${attemptId}/pause`),
  resumeAttempt: (attemptId) => api.post(`proctoring/${attemptId}/resume`),
  listAttemptVideos: (attemptId, opts) => api.get(`proctoring/${attemptId}/videos`, opts),
  listExamVideoUploadStatus: (examId, attemptIds = [], opts = {}) => {
    const params = { ...(opts.params || {}) }
    if (Array.isArray(attemptIds) && attemptIds.length > 0) {
      params.attempt_ids = attemptIds.join(',')
    }
    return api.get(`proctoring/exam/${examId}/video-upload-status`, {
      ...opts,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    })
  },
  getAttemptAnswers: (attemptId, opts) => api.get(`attempts/${attemptId}/answers`, opts),
  reviewAttemptCertificate: (attemptId, decision) => api.post(`attempts/${attemptId}/certificate-review`, { decision }),
  testReportCsv: (testId) => api.get(`reports/test/${testId}`, { responseType: 'blob' }),
  generateTestReportPdf: (testId) => api.get(`reports/test/${testId}/pdf`, { responseType: 'blob' }),
  gradeAttempt: (id, score) => api.post(`attempts/${id}/grade`, null, { params: { score } }),

  // Dashboard
  dashboard: () => api.get('dashboard/'),

  // Notifications
  notifications: () => api.get('notifications/'),
  markNotificationRead: (id) => api.post(`notifications/${id}/read`),

  // Audit Log
  auditLog: (params) => api.get('audit-log/', { params }),

  // Surveys
  surveys: () => api.get('surveys/'),
  createSurvey: (data) => api.post('surveys/', data),

  // User Groups
  userGroups: (opts) => api.get('user-groups/', opts),
  createUserGroup: (data) => api.post('user-groups/', data),
  deleteUserGroup: (id) => api.delete(`user-groups/${id}`),
  getUserGroupMembers: (id, opts) => api.get(`user-groups/${id}/members`, opts),
  addUserGroupMember: (groupId, userId) => api.post(`user-groups/${groupId}/members`, { user_id: userId }),
  addUserGroupMembersBulk: (groupId, userIds) => api.post(`user-groups/${groupId}/members/bulk`, { user_ids: userIds }),
  removeUserGroupMember: (groupId, userId) => api.delete(`user-groups/${groupId}/members/${userId}`),

  // Exam Templates
  examTemplates: () => api.get('exam-templates/'),
  createExamTemplate: (data) => api.post('exam-templates/', data),
  updateExamTemplate: (id, data) => api.put(`exam-templates/${id}`, data),
  deleteExamTemplate: (id) => api.delete(`exam-templates/${id}`),

  // Report Schedules
  reportSchedules: () => api.get('report-schedules/'),
  createReportSchedule: (data) => api.post('report-schedules/', data),
  deleteReportSchedule: (id) => api.delete(`report-schedules/${id}`),
  runReportSchedule: (id) => api.post(`report-schedules/${id}/run`),

  // Integrations
  testIntegrations: (config) => api.post('integrations/test', config),
  generatePredefinedReport: (slug) => api.post(`reports/predefined/${slug}`, null, { responseType: 'blob' }),
  previewCustomReport: (payload) => api.post('reports/export/preview', payload),
  exportCustomReport: (payload) => api.post('reports/export', payload, { responseType: 'blob' }),

  // Admin Settings
  settings: () => api.get('admin-settings/'),
  updateSetting: (key, value) => api.put(`admin-settings/${key}`, { value }),
  getSetting: (key) => api.get(`admin-settings/${key}`),
}
