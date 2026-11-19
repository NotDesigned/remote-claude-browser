// Sampled from Faker's English locale. Only the short example lists ship to the browser.
const exampleFirstNames =
  "Ottilie Melvin Amelia Eino Olga Luisa Manuel Ryann Jarod Thalia Veronica Arden Eladio Margaret Betsy Arthur Eldon Ervin".split(
    " ",
  );
const exampleLastNames =
  "Zulauf Kessler Haag Durgan Koch Hane Kuhlman MacGyver Feil Mitchell Price Bailey Kulas Nolan Volkman Veum Paucek Yost".split(
    " ",
  );

function registrationExample() {
  const start = Date.UTC(1995, 0, 1);
  const end = Date.UTC(2006, 0, 1);
  return {
    firstName: exampleFirstNames[Math.floor(Math.random() * exampleFirstNames.length)]!,
    lastName: exampleLastNames[Math.floor(Math.random() * exampleLastNames.length)]!,
    birthday: new Date(start + Math.random() * (end - start)).toISOString().slice(0, 10),
  };
}

export function AppleRegistrationFields({
  options,
  busy = false,
  onGenerate,
}: {
  options: { countries: [string, string][]; phoneCodes: [string, string][] };
  busy?: boolean;
  onGenerate?(): void;
}) {
  return (
    <>
      <div class="user-panel-actions">
        <button
          type="button"
          disabled={busy}
          class="generate-example"
          onClick={(event) => {
            const form = event.currentTarget.form!;
            for (const [name, sample] of Object.entries(registrationExample())) {
              const input = form.elements.namedItem(name) as HTMLInputElement;
              if (!input.value || input.value === input.dataset.example) {
                input.value = sample;
                input.dataset.example = sample;
              }
            }
            onGenerate?.();
          }}
        >
          生成示例
        </button>
      </div>
      <div class="account-onboarding-fields">
        <ExampleField name="lastName" label="姓氏" autoComplete="family-name" />
        <ExampleField name="firstName" label="名字" autoComplete="given-name" />
        <label>
          国家或地区
          <RegistrationSelect name="country" options={options.countries} preferred="USA" />
        </label>
        <ExampleField name="birthday" label="出生日期" autoComplete="bday" />
        <label>
          电话区号
          <RegistrationSelect name="phoneCode" options={options.phoneCodes} preferred="CN" />
        </label>
        <label>
          电话号码
          <input name="phone" type="tel" autoComplete="tel-national" maxLength={40} required />
        </label>
      </div>
    </>
  );
}
function ExampleField({
  name,
  label,
  autoComplete,
}: {
  name: "firstName" | "lastName" | "birthday";
  label: string;
  autoComplete: string;
}) {
  const id = `account-onboarding-${name}`;
  const date = name === "birthday";
  return (
    <div>
      <label for={id}>{label}</label>
      <div class="account-onboarding-example">
        <input
          id={id}
          name={name}
          type={date ? "date" : "text"}
          autoComplete={autoComplete}
          maxLength={date ? undefined : 100}
          onInput={(event) => {
            const field = event.currentTarget;
            if (field.value !== field.dataset.example) delete field.dataset.example;
          }}
          required
        />
      </div>
    </div>
  );
}

function RegistrationSelect({
  name,
  options,
  preferred,
}: {
  name: string;
  options: [string, string][];
  preferred: string;
}) {
  const defaultChoice =
    options.find(([value]) => value === preferred) ??
    (options.length === 1 ? options[0] : undefined);
  return (
    <select name={name} required>
      {!defaultChoice && <option value="">请选择</option>}
      {options.map(([value, label]) => (
        <option key={value} value={value} selected={value === defaultChoice?.[0]}>
          {label}
        </option>
      ))}
    </select>
  );
}
