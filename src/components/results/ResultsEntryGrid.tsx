"use client";

import React, { useState } from "react";
import { ResultStatus } from "@prisma/client";

export interface StudentRow {
  studentId: string;
  name: string;
  admissionNo: string;
  score: number;
  maxScore: number;
  gradeLetter?: string | null;
  status?: ResultStatus;
}

interface ResultsEntryGridProps {
  periodLabel: string;
  subjectName: string;
  students: StudentRow[];
  onSaveScores: (scores: { studentId: string; score: number }[]) => Promise<void>;
  onSubmitBatch?: () => Promise<void>;
  isLocked?: boolean;
}

export function ResultsEntryGrid({
  periodLabel,
  subjectName,
  students,
  onSaveScores,
  onSubmitBatch,
  isLocked = false,
}: ResultsEntryGridProps) {
  const [scores, setScores] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const s of students) map[s.studentId] = s.score;
    return map;
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleScoreChange = (studentId: string, val: string) => {
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0 && num <= 100) {
      setScores((prev) => ({ ...prev, [studentId]: num }));
    } else if (val === "") {
      setScores((prev) => ({ ...prev, [studentId]: 0 }));
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      const payload = Object.entries(scores).map(([studentId, score]) => ({ studentId, score }));
      await onSaveScores(payload);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">{periodLabel}</span>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{subjectName} — Mark Entry</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{students.length} students enrolled in this subject cohort</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isLocked}
            className="min-h-11 px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-50"
          >
            {isSaving ? "Saving..." : "Save Draft"}
          </button>
          {onSubmitBatch && (
            <button
              type="button"
              onClick={onSubmitBatch}
              disabled={isSaving || isLocked}
              className="min-h-11 px-5 py-2.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white transition disabled:opacity-50"
            >
              Submit for Approval
            </button>
          )}
        </div>
      </div>

      {saveSuccess && (
        <div className="p-3 text-sm text-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 rounded-lg border border-emerald-200 dark:border-emerald-800">
          ✓ Scores successfully saved and audited.
        </div>
      )}

      {/* Roster Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
              <th className="py-3 px-4">Student</th>
              <th className="py-3 px-4">Admission No</th>
              <th className="py-3 px-4 text-center">Score / 100</th>
              <th className="py-3 px-4 text-center">Grade</th>
              <th className="py-3 px-4 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {students.map((student) => {
              const currentScore = scores[student.studentId] ?? student.score;
              return (
                <tr key={student.studentId} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition">
                  <td className="py-3.5 px-4 font-medium text-gray-900 dark:text-gray-100">{student.name}</td>
                  <td className="py-3.5 px-4 text-gray-500 dark:text-gray-400 font-mono text-xs">{student.admissionNo}</td>
                  <td className="py-3.5 px-4 text-center">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      disabled={isLocked}
                      value={currentScore}
                      onChange={(e) => handleScoreChange(student.studentId, e.target.value)}
                      className="w-24 min-h-11 px-3 py-1.5 text-center font-semibold rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <span className="inline-block px-2.5 py-1 rounded-md text-xs font-bold bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                      {student.gradeLetter ?? "—"}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    <span
                      className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${
                        student.status === ResultStatus.PUBLISHED
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          : student.status === ResultStatus.APPROVED
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                            : student.status === ResultStatus.SUBMITTED
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                              : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {student.status ?? "DRAFT"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
