import { test, expect } from "@playwright/test";
import {
  isValidTimeString,
  parseTimeToMinutes,
  formatMinutesToTime,
  isValidTimeRange,
  isTimeOverlap,
  findSlotClashes,
  detectAnyClash,
  findBatchClashes,
  validateTimetableSlot,
  groupSlotsByDay,
  type TimetableSlotInput,
} from "@/lib/timetable/rules";

test.describe("Timetable Pure Rules", () => {
  test.describe("time string formatting & arithmetic", () => {
    test("isValidTimeString validates HH:MM 24h formats", () => {
      expect(isValidTimeString("08:00")).toBe(true);
      expect(isValidTimeString("00:00")).toBe(true);
      expect(isValidTimeString("23:59")).toBe(true);
      expect(isValidTimeString("14:35")).toBe(true);

      expect(isValidTimeString("24:00")).toBe(false);
      expect(isValidTimeString("8:00")).toBe(false);
      expect(isValidTimeString("08:60")).toBe(false);
      expect(isValidTimeString("invalid")).toBe(false);
      expect(isValidTimeString("")).toBe(false);
    });

    test("parseTimeToMinutes and formatMinutesToTime are reversible", () => {
      expect(parseTimeToMinutes("00:00")).toBe(0);
      expect(parseTimeToMinutes("08:30")).toBe(510);
      expect(parseTimeToMinutes("14:15")).toBe(855);
      expect(parseTimeToMinutes("23:59")).toBe(1439);

      expect(formatMinutesToTime(0)).toBe("00:00");
      expect(formatMinutesToTime(510)).toBe("08:30");
      expect(formatMinutesToTime(855)).toBe("14:15");
      expect(formatMinutesToTime(1439)).toBe("23:59");
    });

    test("isValidTimeRange rejects inverted or equal time ranges", () => {
      expect(isValidTimeRange("08:00", "09:00")).toBe(true);
      expect(isValidTimeRange("09:00", "08:00")).toBe(false);
      expect(isValidTimeRange("08:00", "08:00")).toBe(false);
      expect(isValidTimeRange("bad", "09:00")).toBe(false);
    });

    test("isTimeOverlap detects overlapping intervals and permits adjacent slots", () => {
      // Overlapping intervals
      expect(isTimeOverlap("08:00", "09:00", "08:30", "09:30")).toBe(true);
      expect(isTimeOverlap("08:30", "09:30", "08:00", "09:00")).toBe(true);
      expect(isTimeOverlap("08:00", "10:00", "08:30", "09:00")).toBe(true); // subset
      expect(isTimeOverlap("08:30", "09:00", "08:00", "10:00")).toBe(true); // superset

      // Contiguous adjacent intervals do NOT overlap
      expect(isTimeOverlap("08:00", "09:00", "09:00", "10:00")).toBe(false);
      expect(isTimeOverlap("09:00", "10:00", "08:00", "09:00")).toBe(false);

      // Disjoint intervals
      expect(isTimeOverlap("08:00", "09:00", "11:00", "12:00")).toBe(false);
    });
  });

  test.describe("clash detection engine", () => {
    const existingSlots: TimetableSlotInput[] = [
      {
        id: "slot-1",
        classArmId: "arm-ss1-a",
        subjectId: "subj-math",
        staffRecordId: "teacher-john",
        dayOfWeek: 1, // Monday
        startTime: "08:00",
        endTime: "09:00",
        room: "Room 101",
      },
      {
        id: "slot-2",
        classArmId: "arm-ss1-b",
        subjectId: "subj-eng",
        staffRecordId: "teacher-mary",
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "10:00",
        room: "Room 102",
      },
      {
        id: "slot-3",
        classArmId: "arm-jss1-a",
        subjectId: "subj-sci",
        staffRecordId: "teacher-john",
        dayOfWeek: 2, // Tuesday
        startTime: "08:00",
        endTime: "09:00",
        room: "Lab 1",
      },
    ];

    test("detects teacher double-booking on overlapping time on same day", () => {
      // Teacher John is already booked Monday 08:00-09:00 in arm-ss1-a
      const candidate: TimetableSlotInput = {
        classArmId: "arm-ss2-b",
        subjectId: "subj-physics",
        staffRecordId: "teacher-john",
        dayOfWeek: 1,
        startTime: "08:30",
        endTime: "09:30",
        room: "Room 205",
      };

      const clashes = findSlotClashes(candidate, existingSlots);
      expect(clashes.length).toBe(1);
      expect(clashes[0].type).toBe("TEACHER_CLASH");
      expect(clashes[0].conflictingSlot.id).toBe("slot-1");
    });

    test("detects class arm clash when same arm is scheduled for two lessons at once", () => {
      // arm-ss1-a is already booked Monday 08:00-09:00 with John
      const candidate: TimetableSlotInput = {
        classArmId: "arm-ss1-a",
        subjectId: "subj-chem",
        staffRecordId: "teacher-mary",
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "09:00",
        room: "Room 303",
      };

      const clash = detectAnyClash(candidate, existingSlots);
      expect(clash).not.toBeNull();
      expect(clash?.type).toBe("CLASS_ARM_CLASH");
    });

    test("detects room clash when different teachers and classes use the same room", () => {
      // Room 101 is used Monday 08:00-09:00
      const candidate: TimetableSlotInput = {
        classArmId: "arm-jss3-c",
        subjectId: "subj-music",
        staffRecordId: "teacher-mary",
        dayOfWeek: 1,
        startTime: "08:15",
        endTime: "08:45",
        room: "room 101", // case-insensitive check
      };

      const clashes = findSlotClashes(candidate, existingSlots);
      expect(clashes.length).toBe(1);
      expect(clashes[0].type).toBe("ROOM_CLASH");
      expect(clashes[0].message).toContain("Room 101");
    });

    test("allows candidate when day differs or time does not overlap", () => {
      // Different day (Tuesday for teacher Mary)
      const candidateTue: TimetableSlotInput = {
        classArmId: "arm-ss1-b",
        subjectId: "subj-eng",
        staffRecordId: "teacher-mary",
        dayOfWeek: 2,
        startTime: "09:00",
        endTime: "10:00",
        room: "Room 102",
      };
      expect(findSlotClashes(candidateTue, existingSlots)).toEqual([]);

      // Contiguous time slot on same day
      const candidateNextHour: TimetableSlotInput = {
        classArmId: "arm-ss1-a",
        subjectId: "subj-geo",
        staffRecordId: "teacher-john",
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "10:00",
        room: "Room 101",
      };
      expect(findSlotClashes(candidateNextHour, existingSlots)).toEqual([]);
    });

    test("ignores self when updating an existing slot", () => {
      const updatingSlot1: TimetableSlotInput = {
        id: "slot-1",
        classArmId: "arm-ss1-a",
        subjectId: "subj-math",
        staffRecordId: "teacher-john",
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "09:00",
        room: "Room 101",
      };
      expect(findSlotClashes(updatingSlot1, existingSlots)).toEqual([]);
    });

    test("findBatchClashes catches collisions within the payload", () => {
      const batch: TimetableSlotInput[] = [
        {
          classArmId: "arm-1",
          subjectId: "sub-1",
          staffRecordId: "teacher-a",
          dayOfWeek: 3,
          startTime: "10:00",
          endTime: "11:00",
          room: "Hall A",
        },
        {
          classArmId: "arm-2",
          subjectId: "sub-2",
          staffRecordId: "teacher-a", // Teacher A scheduled twice!
          dayOfWeek: 3,
          startTime: "10:30",
          endTime: "11:30",
          room: "Hall B",
        },
      ];

      const clashes = findBatchClashes(batch);
      expect(clashes.length).toBe(1);
      expect(clashes[0].type).toBe("TEACHER_CLASH");
    });
  });

  test.describe("validation and grid helpers", () => {
    test("validateTimetableSlot catches missing and invalid fields", () => {
      const invalid = validateTimetableSlot({
        classArmId: "",
        subjectId: "",
        staffRecordId: "",
        dayOfWeek: 8,
        startTime: "10:00",
        endTime: "09:00",
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThanOrEqual(4);

      const valid = validateTimetableSlot({
        classArmId: "arm-1",
        subjectId: "sub-1",
        staffRecordId: "staff-1",
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "10:00",
      });
      expect(valid.valid).toBe(true);
      expect(valid.errors).toEqual([]);
    });

    test("groupSlotsByDay groups and sorts chronologically", () => {
      const slots: TimetableSlotInput[] = [
        {
          classArmId: "a",
          subjectId: "s",
          staffRecordId: "t",
          dayOfWeek: 1,
          startTime: "11:00",
          endTime: "12:00",
        },
        {
          classArmId: "a",
          subjectId: "s",
          staffRecordId: "t",
          dayOfWeek: 1,
          startTime: "08:00",
          endTime: "09:00",
        },
        {
          classArmId: "a",
          subjectId: "s",
          staffRecordId: "t",
          dayOfWeek: 2,
          startTime: "09:00",
          endTime: "10:00",
        },
      ];

      const grouped = groupSlotsByDay(slots);
      expect(grouped[1].length).toBe(2);
      expect(grouped[1][0].startTime).toBe("08:00");
      expect(grouped[1][1].startTime).toBe("11:00");
      expect(grouped[2].length).toBe(1);
      expect(grouped[3].length).toBe(0);
    });
  });
});
