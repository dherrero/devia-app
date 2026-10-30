import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DialogComponent } from './component';
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { NO_ERRORS_SCHEMA } from '@angular/core';

describe('DialogComponent', () => {
  let fixture: ComponentFixture<DialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DialogComponent],
      providers: [
        {
          provide: DialogRef,
          useValue: {
            close: () => {
              /* noop */
            },
          },
        },
        { provide: DIALOG_DATA, useValue: { title: 'Test Dialog' } },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(DialogComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());
});
