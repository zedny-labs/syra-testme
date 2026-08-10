import api from './api'

export const listTests = (params) => api.get('exams/', { params })
export const getTest = (id) => api.get(`exams/${id}`)
export const createTest = (data) => api.post('exams/', data)
export const updateTest = (id, data) => api.put(`exams/${id}`, data)
export const deleteTest = (id) => api.delete(`exams/${id}`)
export const getTestQuestions = (testId) => api.get('questions/', { params: { exam_id: testId } })
export const getLearnerSections = (testId) => api.get(`exams/${testId}/learner-sections`)
export const finishAttemptSection = (attemptId, sectionId) =>
  api.post(`attempts/${attemptId}/sections/${sectionId}/finish`)
